// DolphinSlicer engine bridge: system/user presets through OrcaSlicer's own PresetBundle.
//
// The desktop app turns a printer + process + filament selection into the config it slices
// with in PresetBundle::full_config(). Doing the same here, with the same code, keeps
// `inherits` resolution, compatibility rules and the composed config identical to desktop
// instead of re-implementing ~6000 lines of PresetBundle in TypeScript.
//
// The host writes vendor profile trees into MEMFS under <data_dir>/system (one <Vendor>.json
// index plus its <Vendor>/ folder, exactly as in resources/profiles) and user presets under
// <data_dir>/user/default/{machine,process,filament}, then calls orca_presets_load().
//
// SPDX-License-Identifier: AGPL-3.0-or-later
#include "orca_engine.h"
#include "engine_internal.hpp"
#include "gui_rules.hpp"

#include <libslic3r/libslic3r.h>
#include <libslic3r/AppConfig.hpp>
#include <libslic3r/Preset.hpp>
#include <libslic3r/PresetBundle.hpp>
#include <libslic3r/PrintConfig.hpp>
#include <libslic3r/Utils.hpp>
#include <libslic3r_version.h>

#include <boost/filesystem.hpp>
#include <boost/uuid/detail/md5.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iomanip>
#include <map>
#include <memory>
#include <new>
#include <set>
#include <sstream>
#include <string>
#include <tuple>

using namespace Slic3r;
using json = nlohmann::json;

namespace {

struct Presets
{
    std::unique_ptr<PresetBundle> bundle;
    std::string                   error_json = R"({"code":0,"message":"","detail":""})";
    std::string                   scratch;

    int fail(int code, const std::string &message, const std::string &detail = {})
    {
        error_json = json{{"code", code}, {"message", message}, {"detail", detail}}.dump();
        return code;
    }
    const char *ret(std::string s) { scratch = std::move(s); return scratch.c_str(); }
};

Presets *as_presets(void *p) { return static_cast<Presets *>(p); }

// A preset's name without the printer it is for ("0.20mm Standard @MyKlipper" -> "0.20mm Standard"),
// as it is written in the name of a copy for another printer.
std::string base_name(const std::string &name)
{
    std::string base = name.substr(0, name.find(" @"));
    std::replace(base.begin(), base.end(), '/', '-');
    return base;
}

// Value of a string option, or "" if absent. (Do not use opt_string(key, true) on a const
// config: `true` converts to an index and selects the ConfigOptionStrings overload.)
std::string str_opt(const DynamicPrintConfig &cfg, const char *key)
{
    const auto *o = cfg.option<ConfigOptionString>(key);
    return o ? o->value : std::string();
}

// A nozzle diameter as desktop's sidebar writes it (Plater.cpp get_diameter_string): 0.4, 0.25.
std::string diameter_string(double d)
{
    std::ostringstream os;
    os << std::fixed << std::setprecision(2) << d;
    std::string s = os.str();
    s.erase(s.find_last_not_of('0') + 1);
    if (s.back() == '.') s += '0';
    return s;
}

// A printer preset's variant: its printer_variant, or else its own nozzle (desktop takes the selected
// printer's nozzle for every preset that names none, which lists one size twice and another not).
std::string variant_of(const Preset &pr)
{
    const std::string v = pr.config.opt_string("printer_variant");
    if (!v.empty()) return v;
    const auto *nd = pr.config.option<ConfigOptionFloats>("nozzle_diameter");
    return nd && !nd->values.empty() ? diameter_string(nd->values.front()) : std::string();
}

json preset_entry(const Preset &p)
{
    json j = {
        {"name", p.name},
        {"alias", p.alias},
        {"system", p.is_system},
        {"user", p.is_user()},
        {"inherits", p.inherits()},
        {"vendor", p.vendor ? p.vendor->id : std::string()},
    };
    if (p.type == Preset::TYPE_PRINTER) {
        j["model"]   = str_opt(p.config, "printer_model");
        j["variant"] = variant_of(p);
    } else if (p.type == Preset::TYPE_FILAMENT) {
        const auto *t = p.config.option<ConfigOptionStrings>("filament_type");
        j["filament_type"] = t && !t->values.empty() ? t->values.front() : std::string();
        const auto *v = p.config.option<ConfigOptionStrings>("filament_vendor");
        j["filament_vendor"] = v && !v->values.empty() ? v->values.front() : std::string();
        j["filament_id"]     = p.filament_id;
        // The color desktop's filament combo box draws next to the preset (PresetComboBox::get_bmp).
        const auto *c = p.config.option<ConfigOptionStrings>("default_filament_colour");
        j["default_filament_colour"] = c && !c->values.empty() ? c->values.front() : std::string();
    }
    return j;
}

// Visible presets of a collection; for print/filament only those compatible with the
// selected printer (and print), as the desktop combo boxes show them. The selected one (`keep`)
// is listed even when it doesn't fit (desktop keeps it selected, with a red flag), marked
// "compatible": false.
json list_collection(const PresetCollection &c, bool compatible_only, const std::string &keep = std::string())
{
    json a = json::array();
    for (const Preset &p : c) {
        if (p.is_default || !p.is_visible) continue;
        if (compatible_only && !p.is_compatible && p.name != keep) continue;
        json e = preset_entry(p);
        if (compatible_only && !p.is_compatible) e["compatible"] = false;
        a.push_back(std::move(e));
    }
    return a;
}

PresetCollection *collection(PresetBundle &b, const std::string &type)
{
    if (type == "print") return &b.prints;
    if (type == "filament") return &b.filaments;
    if (type == "printer") return &b.printers;
    return nullptr;
}

// Index into multi-variant option arrays (one value per extruder type / nozzle volume type)
// that the desktop settings tabs edit for one extruder (0-based; the first unless its switch
// between them says otherwise), from the printer's extruder_type and nozzle_volume_type
// (DynamicPrintConfig::get_index_for_extruder).
int variant_index(PresetBundle &b, const std::string &type, int extruder = 0)
{
    const DynamicPrintConfig &printer = b.printers.get_edited_preset().config;
    ExtruderType et = etDirectDrive;
    if (const auto *o = printer.option<ConfigOptionEnumsGeneric>("extruder_type"); o && !o->values.empty()) et = ExtruderType(o->get_at(extruder));
    NozzleVolumeType nvt = nvtStandard;
    if (const auto *o = printer.option<ConfigOptionEnumsGeneric>("nozzle_volume_type"); o && !o->values.empty()) nvt = NozzleVolumeType(o->get_at(extruder));
    int idx = -1;
    if (type == "print") idx = b.prints.get_edited_preset().config.get_index_for_extruder(extruder + 1, "print_extruder_id", et, nvt, "print_extruder_variant");
    else if (type == "filament") idx = b.filaments.get_edited_preset().config.get_index_for_extruder(extruder + 1, "", et, nvt, "filament_extruder_variant");
    else if (type == "printer") idx = printer.get_index_for_extruder(extruder + 1, "printer_extruder_id", et, nvt, "printer_extruder_variant");
    return idx < 0 ? 0 : idx;
}

// For each of the printer's extruders, the index of its values in the multi-variant option
// arrays of the edited preset of one type. A printer's own (desktop's "Extruder N" pages): its
// number where the printer has no variants.
std::vector<int> extruder_indexes(PresetBundle &b, const std::string &type)
{
    const DynamicPrintConfig &printer = b.printers.get_edited_preset().config;
    const auto *nozzles = dynamic_cast<const ConfigOptionVectorBase *>(printer.option("nozzle_diameter"));
    const auto *types = printer.option<ConfigOptionEnumsGeneric>("extruder_type");
    const auto *volumes = printer.option<ConfigOptionEnumsGeneric>("nozzle_volume_type");
    std::vector<int> out;
    for (size_t e = 0; e < (nozzles ? nozzles->size() : 1); ++e) {
        if (type != "printer") { out.push_back(variant_index(b, type, int(e))); continue; }
        const ExtruderType et = types && !types->values.empty() ? ExtruderType(types->get_at(e)) : etDirectDrive;
        const NozzleVolumeType nvt = volumes && !volumes->values.empty() ? NozzleVolumeType(volumes->get_at(e)) : nvtStandard;
        const int idx = printer.get_index_for_extruder(int(e) + 1, "printer_extruder_id", et, nvt, "printer_extruder_variant");
        out.push_back(idx < 0 ? int(e) : idx);
    }
    return out;
}

const std::set<std::string> &variant_keys(const std::string &type)
{
    static const std::set<std::string> none;
    static const std::set<std::string> printer = [] {
        std::set<std::string> k = printer_options_with_variant_1;
        k.insert(printer_options_with_variant_2.begin(), printer_options_with_variant_2.end());
        return k;
    }();
    if (type == "print") return print_options_with_variant;
    if (type == "filament") return filament_options_with_variant;
    if (type == "printer") return printer;
    return none;
}

// Preset metadata the desktop tabs never show as a changed setting. The compatibility settings are
// edited on the Dependencies page, so an edit to them is unsaved (`dirty`); they still don't count
// as differing from the system preset, which a user preset's own list always does.
std::vector<std::string> without_metadata(std::vector<std::string> keys, bool keep_compatibility = false)
{
    static const std::set<std::string> meta = {"inherits", "print_settings_id", "filament_settings_id", "printer_settings_id",
                                               "different_settings_to_system"};
    static const std::set<std::string> compatibility = {"compatible_printers", "compatible_printers_condition", "compatible_prints",
                                                        "compatible_prints_condition"};
    keys.erase(std::remove_if(keys.begin(), keys.end(), [&](const std::string &k) {
        return meta.count(k) > 0 || (!keep_compatibility && compatibility.count(k) > 0);
    }), keys.end());
    return keys;
}

// User presets that inherit from the named preset.
std::vector<std::string> children_of(const PresetCollection &c, const std::string &name)
{
    std::vector<std::string> out;
    for (const Preset &p : c)
        if (!p.is_default && p.inherits() == name) out.push_back(p.name);
    return out;
}

// A user preset's list of compatible printers or print settings, changed: the stored preset, the
// edited copy of a selected one, and its file (only that key changes, as desktop's
// write_legacy_user_filament_preset does).
void set_compatible(PresetCollection &c, Preset &pr, const std::string &key, const std::vector<std::string> &list)
{
    auto &stored = pr.config.option<ConfigOptionStrings>(key, true)->values;
    // The edited copy follows unless that list is being edited.
    if (c.get_selected_preset_name() == pr.name) {
        auto &edited = c.get_edited_preset().config.option<ConfigOptionStrings>(key, true)->values;
        if (edited == stored) edited = list;
    }
    stored = list;
    if (pr.file.empty()) return;
    std::ifstream in(pr.file);
    json f = json::parse(in, nullptr, false);
    in.close();
    if (!f.is_object()) return;
    f[key] = list;
    std::ofstream(pr.file) << f.dump(4) << "\n";
}

// A deleted preset no longer listed as compatible by the user's presets. A list left empty
// means every printer (or print setting) the preset's condition allows, as for any other.
void drop_compatible(PresetCollection &c, const std::string &key, const std::string &name)
{
    for (Preset &pr : c) {
        if (!pr.is_user()) continue;
        const auto *opt = pr.config.option<ConfigOptionStrings>(key);
        if (!opt || std::find(opt->values.begin(), opt->values.end(), name) == opt->values.end()) continue;
        std::vector<std::string> list = opt->values;
        list.erase(std::remove(list.begin(), list.end(), name), list.end());
        set_compatible(c, pr, key, list);
    }
}

// Desktop's CreatePrinterPresetDialog::get_filament_id(): an existing id for this filament name,
// else "P" + the first 7 hex digits of its MD5, unique among the loaded filaments.
std::string new_filament_id(const PresetCollection &filaments, const std::string &filament_name)
{
    std::map<std::string, std::set<std::string>> names_by_id;
    for (const Preset &p : filaments) {
        const size_t at = p.name.find_first_of('@');
        if (at == std::string::npos || at == 0) continue;
        const std::string n = p.name.substr(0, at - 1);
        if (n == filament_name && p.filament_id != "null" && !p.filament_id.empty()) return p.filament_id;
        names_by_id[p.filament_id].insert(n);
    }
    auto md5_7 = [](const std::string &text) {
        boost::uuids::detail::md5 h;
        h.process_bytes(text.data(), text.size());
        boost::uuids::detail::md5::digest_type d;
        h.get_digest(d);
        const auto *bytes = reinterpret_cast<const unsigned char *>(&d);
        char hex[33];
        for (int i = 0; i < 16; ++i) std::snprintf(hex + 2 * i, 3, "%02x", bytes[i]);
        return std::string(hex, 7);
    };
    std::string id = "P" + md5_7(filament_name);
    for (int salt = 1; names_by_id.count(id) && !names_by_id[id].count(filament_name); ++salt)
        id = "P" + md5_7(filament_name + "#" + std::to_string(salt));
    return id;
}

// Desktop's CreatePrinterPresetDialog::generate_process_presets_data(): process templates are
// adapted to the new printer's nozzle when a printer is created from a template.
void adapt_process_to_nozzle(DynamicPrintConfig &cfg, float nozzle)
{
    auto set_float = [&](const char *key, double v) { if (auto *o = cfg.option<ConfigOptionFloat>(key)) o->value = v; };
    auto set_int = [&](const char *key, int v) { if (auto *o = cfg.option<ConfigOptionInt>(key)) o->value = v; };
    set_float("layer_height", nozzle / 2);
    set_float("initial_layer_print_height", nozzle / 2);
    for (const char *k : {"line_width", "initial_layer_line_width", "outer_wall_line_width", "inner_wall_line_width", "top_surface_line_width",
                          "sparse_infill_line_width", "internal_solid_infill_line_width", "support_line_width"})
        set_float(k, nozzle);
    set_int("wall_loops", std::max(2, (int) std::ceil(2 * 0.4 / nozzle)));
    set_int("top_shell_layers", std::max(5, (int) std::ceil(5 * 0.4 / nozzle)));
    set_int("bottom_shell_layers", std::max(3, (int) std::ceil(3 * 0.4 / nozzle)));
}

// `extruder`: which of the printer's extruders the settings are shown for (the switch between
// them): its index into the lists with a value per variant, and the rules for its values.
json values_json(PresetBundle &b, const std::string &type, int extruder)
{
    extruder = std::clamp(extruder, 0, std::max(0, b.get_printer_extruder_count() - 1));
    PresetCollection &c = *collection(b, type);
    const Preset     &edited = c.get_edited_preset();
    const Preset     &selected = c.get_selected_preset();
    json values = json::object();
    for (const std::string &key : edited.config.keys()) {
        const ConfigOption *o = edited.config.option(key);
        if (o->is_vector()) values[key] = static_cast<const ConfigOptionVectorBase *>(o)->vserialize();   // one string per element
        else values[key] = o->serialize();
    }
    const auto &vk = variant_keys(type);
    return {
        {"type", type},
        {"name", selected.name},
        {"system", selected.is_system},
        {"user", selected.is_user()},
        {"inherits", selected.inherits()},
        // A root: system, or a user preset with no parent (desktop's "custom root preset").
        {"base", c.get_preset_base(selected) == &selected},
        {"children", children_of(c, selected.name)},
        // A custom printer's own presets, deleted along with it (desktop asks first).
        {"attached", type == "printer" && !selected.is_system && c.get_preset_base(selected) == &selected
                         ? json{{"filament", b.filaments.get_user_presets_for_printer(selected.name).size()},
                                {"print", b.prints.get_user_presets_for_printer(selected.name).size()}}
                         : json{{"filament", 0}, {"print", 0}}},
        {"file", selected.is_user() ? selected.file : std::string()},
        {"dirty", without_metadata(c.current_dirty_options(true), true)},
        {"from_system", without_metadata(c.get_selected_preset_parent() ? c.current_different_from_parent_options(true) : std::vector<std::string>())},
        {"variant_index", variant_index(b, type, extruder)},
        {"states", orca_option_states(b, type, variant_index(b, type, extruder))},
        {"variant_keys", std::vector<std::string>(vk.begin(), vk.end())},
        {"extruders", extruder_indexes(b, type)},
        // Desktop names the two nozzles of a Bambu Lab printer by their side (left, right).
        {"sides", b.is_bbl_vendor() && b.get_printer_extruder_count() == 2},
        {"values", std::move(values)},
    };
}

// The selected printer's variants as desktop's sidebar lists them
// (PresetCollection::diameters_of_selected_printer): those of every printer preset of its model.
// {variants[], variant}
json printer_variants(const PresetBundle &b)
{
    const Preset &pr = b.printers.get_edited_preset();
    const std::string model = pr.config.opt_string("printer_model");
    std::set<std::string> set;
    if (!model.empty())
        for (const Preset &x : b.printers)
            if (!x.is_default && x.config.opt_string("printer_model") == model) set.insert(variant_of(x));
    const std::string own = variant_of(pr);
    set.insert(own);
    set.erase(std::string());
    return {{"variants", std::vector<std::string>(set.begin(), set.end())}, {"variant", own}};
}

// The plate types the selected printer offers, as desktop's sidebar lists them
// (Sidebar::reset_bed_type_combox_choices): all but those its model doesn't support. None when it
// has one bed type (not Bambu Lab, no "Support multiple bed types"): desktop hides the choice.
std::vector<std::string> bed_types(PresetBundle &b)
{
    const Preset &pr = b.printers.get_edited_preset();
    if (!b.is_bbl_vendor() && !pr.config.opt_bool("support_multi_bed_types")) return {};
    const VendorProfile::PrinterModel *pm = PresetUtils::system_printer_model(b.printers.get_selected_preset());
    if (!pm)
        if (const Preset *parent = b.printers.get_selected_preset_parent()) pm = PresetUtils::system_printer_model(*parent);
    const ConfigOptionDef *def = print_config_def.get("curr_bed_type");
    std::vector<std::string> out;
    for (size_t i = 0; i < def->enum_labels.size() && i < def->enum_values.size(); ++i)
        if (!pm || std::find(pm->not_support_bed_types.begin(), pm->not_support_bed_types.end(), def->enum_labels[i]) == pm->not_support_bed_types.end())
            out.push_back(def->enum_values[i]);
    return out;
}

// The plate type sliced with (the project's curr_bed_type, which the bed temperatures follow).
void set_bed_type(PresetBundle &b, BedType t)
{
    b.project_config.set_key_value("curr_bed_type", new ConfigOptionEnum<BedType>(t));
}

json state_json(PresetBundle &b)
{
    return {
        {"printer_variants", printer_variants(b)},
        {"bed_types", bed_types(b)},
        {"bed_type", b.project_config.opt_serialize("curr_bed_type")},
        {"printer", b.printers.get_selected_preset_name()},
        {"process", b.prints.get_selected_preset_name()},
        {"filaments", b.filament_presets},
        {"processes", list_collection(b.prints, true, b.prints.get_selected_preset_name())},
        {"filament_presets", list_collection(b.filaments, true, b.filament_presets.empty() ? std::string() : b.filament_presets.front())},
        // Presets with unsaved edits, which selecting another preset of that type discards.
        {"dirty", {{"print", b.prints.current_is_dirty()}, {"filament", b.filaments.current_is_dirty()},
                   {"printer", b.printers.current_is_dirty()}}},
    };
}

} // namespace

namespace orca_bridge {
PresetBundle *presets_bundle(void *presets) { return presets ? as_presets(presets)->bundle.get() : nullptr; }
int presets_fail(void *presets, int code, const std::string &message, const std::string &detail)
{
    return as_presets(presets)->fail(code, message, detail);
}
const char *presets_ret(void *presets, std::string s) { return as_presets(presets)->ret(std::move(s)); }
} // namespace orca_bridge

extern "C" {

void *orca_presets_create(void)
{
    try { return new Presets(); } catch (...) { return nullptr; }
}

void orca_presets_destroy(void *p) { delete as_presets(p); }

int orca_presets_load(void *p, const char *data_dir)
{
    Presets &ps = *as_presets(p);
    try {
        set_data_dir(data_dir ? data_dir : "/orca");
        // The profiles keep their own resource paths (bed textures, models) relative to
        // resources_dir(); none of that is read by the engine.
        set_resources_dir(std::string(data_dir ? data_dir : "/orca") + "/resources");
        // The user preset folder must exist: PresetBundle::load_user_presets() returns early
        // without one (read-only load), and then has no folder to save new user presets in.
        boost::filesystem::create_directories(std::string(data_dir ? data_dir : "/orca") + "/" + PRESET_USER_DIR + "/" + DEFAULT_USER_FOLDER_NAME);
        AppConfig   app_config;   // defaults: no installed-vendor filter, nothing selected
        std::string errors;
        auto bundle = std::make_unique<PresetBundle>();
        bundle->load_presets(app_config, ForwardCompatibilitySubstitutionRule::EnableSilent,
                             PresetBundle::PresetPreferences(), &errors, /*read_only=*/true);
        // The desktop app shows only the printer variants installed via its setup wizard
        // (AppConfig "vendors" section). Here the host decides which vendors to load at all,
        // so every loaded printer is selectable.
        for (Preset &pr : bundle->printers)
            if (!pr.is_default) pr.is_visible = true;
        set_bed_type(*bundle, bundle->printers.get_edited_preset().get_default_bed_type(bundle.get()));
        ps.bundle = std::move(bundle);
        if (!errors.empty())
            ps.fail(ORCA_OK, "Some presets could not be loaded", errors);
        return ORCA_OK;
    } catch (const std::bad_alloc &) {
        return ps.fail(ORCA_OOM, "Out of memory while loading presets");
    } catch (const std::exception &ex) {
        return ps.fail(ORCA_INVALID_CONFIG, "Could not load presets", ex.what());
    }
}

// JSON {printers:[…]} — every visible printer preset (system and user).
const char *orca_presets_list(void *p)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle) return ps.ret("{\"printers\":[]}");
    return ps.ret(json{{"printers", list_collection(ps.bundle->printers, false)}}.dump());
}

// The printer preset a selection switches to ("" for none): its printer, or the printer of the
// selected one's model with its variant (nozzle), as desktop's sidebar picks it
// (Sidebar::priv::switch_diameter_to). Throws for a variant the model has no printer with.
static std::string selection_printer(PresetBundle &b, const json &j)
{
    std::string printer_name = j.value("printer", std::string());
    if (j.contains("variant") && printer_name.empty()) {
        const std::string variant = j["variant"].get<std::string>();
        if (variant_of(b.printers.get_selected_preset()) != variant) {
            Preset *similar = b.get_similar_printer_preset({}, variant);
            // Desktop's lookup goes by the variant names; a printer naming none is found by
            // its nozzle (a system preset first).
            if (!similar || variant_of(*similar) != variant) {
                similar = nullptr;
                const std::string model = b.printers.get_selected_preset().config.opt_string("printer_model");
                for (Preset &x : b.printers)
                    if (!x.is_default && x.config.opt_string("printer_model") == model && variant_of(x) == variant &&
                        (!similar || (x.is_system && !similar->is_system)))
                        similar = &x;
            }
            if (!similar) throw std::invalid_argument("No printer preset with this nozzle: " + variant);
            printer_name = similar->name;
        }
    }
    return printer_name;
}

// Select {printer?, variant?, process?, filaments?[], bed_type?} like the desktop combo boxes do: choosing a printer
// re-evaluates compatibility and switches an incompatible process/filament to a compatible one.
// Returns ORCA_OK; orca_presets_state() then has the effective selection and the lists.
// Selecting the preset that is already selected keeps its unsaved edits (force = false); only a
// different preset replaces them. The host asks before that (state "dirty").
int orca_presets_select(void *p, const char *json_text)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle) return ps.fail(ORCA_INVALID_CONFIG, "Presets not loaded");
    try {
        PresetBundle &b = *ps.bundle;
        const json    j = json::parse(json_text ? json_text : "", nullptr, false);
        if (!j.is_object()) return ps.fail(ORCA_INVALID_CONFIG, "Selection must be a JSON object");
        std::string printer_name;
        try {
            printer_name = selection_printer(b, j);
        } catch (const std::invalid_argument &ex) {
            return ps.fail(ORCA_INVALID_CONFIG, ex.what());
        }
        const bool printer_changed = !printer_name.empty();
        if (printer_changed) {
            const std::string name = printer_name;
            if (!b.printers.find_preset(name, false)) return ps.fail(ORCA_INVALID_CONFIG, "Unknown printer preset", name);
            b.printers.select_preset_by_name(name, false);
            // One filament per tool here (the app has no extra filament slots): none are left
            // over from a printer with more tools.
            const size_t tools = b.printers.get_edited_preset().config.opt_bool("single_extruder_multi_material")
                ? 1 : std::max<size_t>(1, size_t(b.get_printer_extruder_count()));
            if (b.filament_presets.size() > tools) b.filament_presets.resize(tools);
            b.update_multi_material_filament_presets();
            b.update_compatible(PresetSelectCompatibleType::Always);
        }
        // "defaults": take the printer's default process and filament (what the desktop setup
        // wizard selects for a newly added printer) unless given explicitly.
        if (j.value("defaults", false) && printer_changed) {
            const Preset &pr = b.printers.get_selected_preset();
            const std::string def_print = str_opt(pr.config, "default_print_profile");
            // A custom printer keeps its template's defaults, which may not fit it: then its own
            // preset of that name ("0.20mm Standard @<printer>"), or else the first that fits
            // (never the placeholder "Default Setting" while there are others).
            auto fitting = [](const PresetCollection &c, const std::string &wanted) -> const Preset * {
                const Preset *first = nullptr;
                for (const Preset &x : c) {
                    if (x.is_default || !x.is_visible || !x.is_compatible) continue;
                    if (!wanted.empty() && base_name(x.name) == base_name(wanted)) return &x;
                    if (!first) first = &x;
                }
                return first;
            };
            if (!j.contains("process")) {
                const Preset *pp = def_print.empty() ? nullptr : b.prints.find_preset(def_print, false);
                if (!pp || !pp->is_compatible) pp = fitting(b.prints, def_print);
                if (pp) b.prints.select_preset_by_name(pp->name, false);
            }
            const auto *def_fil = pr.config.option<ConfigOptionStrings>("default_filament_profile");
            if (!j.contains("filaments")) {
                const std::string wanted = def_fil && !def_fil->values.empty() ? def_fil->values.front() : std::string();
                const Preset *fp = wanted.empty() ? nullptr : b.filaments.find_preset(wanted, false);
                if (!fp || !fp->is_compatible) fp = fitting(b.filaments, wanted);
                if (fp) {
                    b.filament_presets.assign(b.filament_presets.empty() ? 1 : b.filament_presets.size(), fp->name);
                    b.filaments.select_preset_by_name(fp->name, false);
                }
            }
        }
        if (j.contains("process")) {
            const std::string name = j["process"].get<std::string>();
            if (!b.prints.find_preset(name, false)) return ps.fail(ORCA_INVALID_CONFIG, "Unknown process preset", name);
            b.prints.select_preset_by_name(name, false);
        }
        if (j.contains("filaments")) {
            const auto names = j["filaments"].get<std::vector<std::string>>();
            for (size_t i = 0; i < names.size(); ++i)
                if (!b.filaments.find_preset(names[i], false))
                    return ps.fail(ORCA_INVALID_CONFIG, "Unknown filament preset", names[i]);
            if (!names.empty()) {
                b.filament_presets = names;
                b.filaments.select_preset_by_name(names.front(), false);
            }
        }
        // The plate type: the one asked for when the printer offers it; else, on another printer
        // or one with a single bed type, the printer's default (desktop keeps the last one per
        // printer in its app config; the host does that here and passes it along).
        const std::vector<std::string> types = bed_types(b);
        const std::string want = j.value("bed_type", std::string());
        BedType bt = btDefault;
        if (!want.empty() && std::find(types.begin(), types.end(), want) != types.end() &&
            ConfigOptionEnum<BedType>::from_string(want, bt))
            set_bed_type(b, bt);
        else if (printer_changed || types.empty())
            set_bed_type(b, b.printers.get_edited_preset().get_default_bed_type(&b));
        b.update_compatible(PresetSelectCompatibleType::Never);
        return ORCA_OK;
    } catch (const std::exception &ex) {
        return ps.fail(ORCA_INVALID_CONFIG, "Invalid selection", ex.what());
    }
}

// The preset types whose unsaved edits a selection drops, as desktop's Tab::select_preset finds
// them: the printer's when it is another printer; the print settings' and filament's when they
// don't fit it (those that do keep their edits). {printer?, variant?, process?, filaments?[]} →
// {"lost": [types]}; NULL on error.
const char *orca_presets_select_loses(void *p, const char *json_text)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle) { ps.fail(ORCA_INVALID_CONFIG, "Presets not loaded"); return nullptr; }
    try {
        PresetBundle &b = *ps.bundle;
        const json    j = json::parse(json_text ? json_text : "", nullptr, false);
        if (!j.is_object()) { ps.fail(ORCA_INVALID_CONFIG, "Selection must be a JSON object"); return nullptr; }
        std::vector<std::string> lost;
        const std::string printer = selection_printer(b, j);
        const Preset *to = printer.empty() ? nullptr : b.printers.find_preset(printer, false);
        if (!printer.empty() && !to) { ps.fail(ORCA_INVALID_CONFIG, "Unknown printer preset", printer); return nullptr; }
        if (to && to->name == b.printers.get_selected_preset_name()) to = nullptr;
        if (to && b.printers.current_is_dirty()) lost.push_back("printer");
        for (auto [type, col, key] : {std::tuple<const char *, PresetCollection *, const char *>{"print", &b.prints, "process"},
                                      {"filament", &b.filaments, "filaments"}}) {
            if (!col->current_is_dirty()) continue;
            const std::string current = col->get_selected_preset_name();
            bool replaced = false;
            if (j.contains(key)) {
                const std::string want = j[key].is_array() ? (j[key].empty() ? current : j[key][0].get<std::string>())
                                                           : j[key].get<std::string>();
                replaced = want != current;
            }
            if (!replaced && to)
                replaced = !is_compatible_with_printer(col->get_edited_preset_with_vendor_profile(),
                                                       b.printers.get_preset_with_vendor_profile(*to));
            if (replaced) lost.push_back(type);
        }
        return ps.ret(json{{"lost", lost}}.dump());
    } catch (const std::exception &ex) {
        ps.fail(ORCA_INVALID_CONFIG, "Invalid selection", ex.what());
        return nullptr;
    }
}

const char *orca_presets_state(void *p)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle) return ps.ret("{}");
    return ps.ret(state_json(*ps.bundle).dump());
}

// The selection's full config, serialized as the desktop app writes project_settings.config
// in a 3MF (the format orca_set_config takes). NULL on error.
const char *orca_presets_full_config(void *p)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle) { ps.fail(ORCA_INVALID_CONFIG, "Presets not loaded"); return nullptr; }
    try {
        // Each filament slot takes its preset's default color, as desktop's update_ams_color does
        // when a filament is chosen (the app has no color box of its own per slot). A preset with
        // none leaves the slot's color.
        PresetBundle &b = *ps.bundle;
        auto &slots = b.project_config.option<ConfigOptionStrings>("filament_colour", true)->values;
        if (slots.size() < b.filament_presets.size()) slots.resize(b.filament_presets.size(), "#26A69A");
        for (size_t i = 0; i < b.filament_presets.size(); ++i) {
            const Preset *f = i == 0 ? &b.filaments.get_edited_preset() : b.filaments.find_preset(b.filament_presets[i], false);
            const auto *c = f ? f->config.option<ConfigOptionStrings>("default_filament_colour") : nullptr;
            if (c && !c->values.empty() && !c->values.front().empty()) slots[i] = c->values.front();
        }
        DynamicPrintConfig cfg = b.full_config();
        std::ostringstream os;
        cfg.save_to_json(os, "project_settings", "project", SoftFever_VERSION);
        return ps.ret(os.str());
    } catch (const std::exception &ex) {
        ps.fail(ORCA_INVALID_CONFIG, "Could not compose the config", ex.what());
        return nullptr;
    }
}

const char *orca_presets_last_error(void *p) { return as_presets(p)->error_json.c_str(); }

// Values of the edited preset of one type ("print" | "filament" | "printer"), with the keys that
// differ from the saved preset ("dirty") and from its system parent ("from_system").
const char *orca_presets_values(void *p, const char *type, int extruder)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle || !collection(*ps.bundle, type ? type : "")) { ps.fail(ORCA_INVALID_CONFIG, "Unknown preset type"); return nullptr; }
    try {
        return ps.ret(values_json(*ps.bundle, type, extruder).dump());
    } catch (const std::exception &ex) {
        ps.fail(ORCA_INVALID_CONFIG, "Could not read the preset", ex.what());
        return nullptr;
    }
}

// Edit the selected preset of one type: {"type": "print", "values": {"key": "serialized value"}}.
// Values use the serialization of the config files (e.g. "0.2", "50%", "1", "a;b" for strings).
// All or nothing: on an invalid value nothing changes and the error names the key.
int orca_presets_edit(void *p, const char *json_text)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle) return ps.fail(ORCA_INVALID_CONFIG, "Presets not loaded");
    const json j = json::parse(json_text ? json_text : "", nullptr, false);
    PresetCollection *c = j.is_object() ? collection(*ps.bundle, j.value("type", "")) : nullptr;
    if (!c || !j.contains("values") || !j["values"].is_object()) return ps.fail(ORCA_INVALID_CONFIG, "Edit must be {type, values}");
    DynamicPrintConfig cfg = c->get_edited_preset().config;
    for (const auto &[key, v] : j["values"].items()) {
        if (!cfg.has(key)) return ps.fail(ORCA_INVALID_CONFIG, "Unknown setting", key);
        try {
            ConfigSubstitutionContext ctx(ForwardCompatibilitySubstitutionRule::Disable);
            if (v.is_object()) {
                auto *vec = dynamic_cast<ConfigOptionVectorBase *>(cfg.option(key));
                if (!vec) return ps.fail(ORCA_INVALID_CONFIG, "Not a list setting", key);
                // Strings are taken verbatim: their list serialization splits on ';', which is
                // also G-code's comment character.
                auto *strs = dynamic_cast<ConfigOptionStrings *>(vec);
                auto element = [&](const std::string &text) {
                    DynamicPrintConfig one;
                    one.set_deserialize(key, text, ctx);
                    return std::unique_ptr<ConfigOption>(one.option(key)->clone());
                };
                if (v.contains("elements")) {
                    // The whole list: {"elements": ["…", …]} (e.g. bed shape points, post-process scripts).
                    const auto elems = v["elements"].get<std::vector<std::string>>();
                    if (strs) strs->values = elems;
                    else {
                        vec->resize(elems.size());
                        for (size_t i = 0; i < elems.size(); ++i) vec->set_at(element(elems[i]).get(), i, 0);
                    }
                } else {
                    // One element: {"index": i, "value": "…"} (the element as orca_presets_values returns it).
                    const size_t i = v.value("index", size_t(0));
                    if (i >= vec->size()) return ps.fail(ORCA_INVALID_CONFIG, "Invalid index", key);
                    if (strs) strs->values[i] = v.value("value", std::string());
                    else vec->set_at(element(v.value("value", std::string())).get(), i, 0);
                }
            } else {
                cfg.set_deserialize(key, v.is_string() ? v.get<std::string>() : v.dump(), ctx);
            }
        } catch (const std::exception &ex) {
            return ps.fail(ORCA_INVALID_CONFIG, "Invalid value", key + ": " + ex.what());
        }
    }
    c->get_edited_preset().config = std::move(cfg);
    ps.bundle->update_compatible(PresetSelectCompatibleType::Never);
    return ORCA_OK;
}

// Reset keys (all if "keys" is absent) of one type to the saved preset ("to": "saved") or to its
// system parent ("to": "system").
int orca_presets_reset(void *p, const char *json_text)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle) return ps.fail(ORCA_INVALID_CONFIG, "Presets not loaded");
    const json j = json::parse(json_text ? json_text : "", nullptr, false);
    PresetCollection *c = j.is_object() ? collection(*ps.bundle, j.value("type", "")) : nullptr;
    if (!c) return ps.fail(ORCA_INVALID_CONFIG, "Reset must be {type, keys?, to?}");
    const Preset *ref = j.value("to", "saved") == "system" && c->get_selected_preset_parent() ? c->get_selected_preset_parent()
                                                                                               : &c->get_selected_preset();
    DynamicPrintConfig &cfg = c->get_edited_preset().config;
    std::vector<std::string> keys = j.contains("keys") ? j["keys"].get<std::vector<std::string>>() : cfg.keys();
    for (const std::string &k : keys)
        if (const ConfigOption *o = ref->config.option(k)) cfg.set_key_value(k, o->clone());
    ps.bundle->update_compatible(PresetSelectCompatibleType::Never);
    return ORCA_OK;
}

// Save the edited preset of one type under a name, as the desktop "Save" does (a user preset
// that stores its differences to the system parent). The file is written to
// <data_dir>/user/default/...; the result names it: {"name", "file"}.
const char *orca_presets_save(void *p, const char *json_text)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle) { ps.fail(ORCA_INVALID_CONFIG, "Presets not loaded"); return nullptr; }
    try {
        const json j = json::parse(json_text ? json_text : "", nullptr, false);
        const std::string type = j.is_object() ? j.value("type", "") : "";
        const std::string name = j.is_object() ? j.value("name", "") : "";
        PresetCollection *c = collection(*ps.bundle, type);
        if (!c || name.empty()) { ps.fail(ORCA_INVALID_CONFIG, "Save must be {type, name}"); return nullptr; }
        if (const Preset *existing = c->find_preset(name, false); existing && !existing->can_overwrite()) {
            ps.fail(ORCA_INVALID_CONFIG, "A system preset has this name", name);
            return nullptr;
        }
        // detach: a preset with no parent (all values its own), as desktop's "Detach" saves it.
        c->save_current_preset(name, j.value("detach", false), false);
        if (type == "filament") {
            if (ps.bundle->filament_presets.empty()) ps.bundle->filament_presets.push_back(name);
            else ps.bundle->filament_presets.front() = name;
        }
        ps.bundle->update_compatible(PresetSelectCompatibleType::Never);
        const Preset &saved = c->get_selected_preset();
        return ps.ret(json{{"name", saved.name}, {"file", saved.file}}.dump());
    } catch (const std::exception &ex) {
        ps.fail(ORCA_INVALID_CONFIG, "Could not save the preset", ex.what());
        return nullptr;
    }
}

// Delete a user preset {type, name} (its files too) and select a compatible one instead.
int orca_presets_delete(void *p, const char *json_text)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle) return ps.fail(ORCA_INVALID_CONFIG, "Presets not loaded");
    try {
        const json j = json::parse(json_text ? json_text : "", nullptr, false);
        const std::string type = j.is_object() ? j.value("type", "") : "";
        PresetCollection *c = collection(*ps.bundle, type);
        const std::string name = j.is_object() ? j.value("name", "") : "";
        const Preset *pr = c ? c->find_preset(name, false) : nullptr;
        if (!pr || pr->name != name || !pr->is_user()) return ps.fail(ORCA_INVALID_CONFIG, "Not a user preset", name);
        // As desktop: a preset other presets inherit from cannot be deleted.
        if (const auto kids = children_of(*c, name); !kids.empty())
            return ps.fail(ORCA_INVALID_CONFIG, "Presets inherited by other presets cannot be deleted", json(kids).dump());
        // A custom printer (a root user printer) takes the presets made for it alone with it (desktop's Tab::select_preset).
        std::vector<std::pair<PresetCollection *, std::string>> attached;
        if (type == "printer" && c->get_preset_base(*pr) == pr)
            for (PresetCollection *col : {(PresetCollection *) &ps.bundle->filaments, (PresetCollection *) &ps.bundle->prints}) {
                std::vector<std::string> kids, roots;
                for (const Preset *a : col->get_user_presets_for_printer(name)) (a->inherits().empty() ? roots : kids).push_back(a->name);
                for (auto &n : kids) attached.emplace_back(col, n);
                for (auto &n : roots) attached.emplace_back(col, n);
            }
        if (c->get_selected_preset_name() != name) c->select_preset_by_name(name, false);
        if (!c->delete_current_preset()) return ps.fail(ORCA_INVALID_CONFIG, "Could not delete the preset", name);
        for (auto &[col, n] : attached) {
            const std::string keep = col->get_selected_preset_name();
            // (false from select_preset_by_name can also mean it is selected already.)
            col->select_preset_by_name(n, true);
            if (col->get_selected_preset_name() != n) continue;
            if (children_of(*col, n).empty()) col->delete_current_preset();
            if (keep != n) col->select_preset_by_name(keep, false);
        }
        // Desktop leaves the deleted name in the lists of the presets made for it and others.
        if (type == "printer") {
            drop_compatible(ps.bundle->filaments, "compatible_printers", name);
            drop_compatible(ps.bundle->prints, "compatible_printers", name);
        }
        if (type == "print") drop_compatible(ps.bundle->filaments, "compatible_prints", name);
        if (type == "printer") ps.bundle->update_multi_material_filament_presets();
        if (type == "filament" && !ps.bundle->filament_presets.empty())
            ps.bundle->filament_presets.front() = c->get_selected_preset_name();
        ps.bundle->update_compatible(PresetSelectCompatibleType::Always);
        return ORCA_OK;
    } catch (const std::exception &ex) {
        return ps.fail(ORCA_INVALID_CONFIG, "Could not delete the preset", ex.what());
    }
}

// Import preset files already in MEMFS (desktop user-preset .json or .orca_printer /
// .orca_filament / .orca_bundle) with the desktop import. A user preset of the same name is
// replaced when "replace" lists it, and otherwise kept and reported (desktop asks per name).
// Returns {"imported": [presets], "existing": [names]} or NULL.
const char *orca_presets_import(void *p, const char *json_text)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle) { ps.fail(ORCA_INVALID_CONFIG, "Presets not loaded"); return nullptr; }
    try {
        const json j = json::parse(json_text ? json_text : "", nullptr, false);
        std::vector<std::string> files = j.is_object() && j.contains("files") ? j["files"].get<std::vector<std::string>>() : std::vector<std::string>();
        std::set<std::string> before[3];
        PresetCollection *cols[3] = {&ps.bundle->prints, &ps.bundle->filaments, &ps.bundle->printers};
        for (int i = 0; i < 3; ++i)
            for (const Preset &pr : *cols[i]) before[i].insert(pr.name + "\x1f" + pr.file);
        AppConfig app_config;
        std::set<std::string> replace;
        if (j.is_object() && j.contains("replace")) replace = j["replace"].get<std::set<std::string>>();
        // Asked per name: 1 replaces the preset, 0 keeps it.
        std::set<std::string> replaced, existing;
        ps.bundle->import_presets(files, [&](const std::string &name) {
                                      if (replace.count(name)) { replaced.insert(name); return 1; }
                                      existing.insert(name);
                                      return 0;
                                  },
                                  ForwardCompatibilitySubstitutionRule::EnableSilent, app_config);
        // A replaced preset that is selected: the edited copy follows the new one.
        for (PresetCollection *c : cols)
            if (replaced.count(c->get_selected_preset_name())) c->select_preset_by_name(c->get_selected_preset_name(), true);
        for (Preset &pr : ps.bundle->printers)
            if (!pr.is_default) pr.is_visible = true;
        ps.bundle->update_compatible(PresetSelectCompatibleType::Never);
        json imported = json::array();
        static const char *types[3] = {"print", "filament", "printer"};
        for (int i = 0; i < 3; ++i)
            for (const Preset &pr : *cols[i])
                if (pr.is_user() && (!before[i].count(pr.name + "\x1f" + pr.file) || replaced.count(pr.name)))
                    imported.push_back({{"type", types[i]}, {"name", pr.name}, {"file", pr.file}});
        return ps.ret(json{{"imported", imported}, {"existing", existing}}.dump());
    } catch (const std::exception &ex) {
        ps.fail(ORCA_INVALID_CONFIG, "Could not import", ex.what());
        return nullptr;
    }
}

// Presets a new printer can start from (desktop's Create Printer dialog, page 2): the process and
// filament presets compatible with the given printer. {printer} → {processes[], filaments[]}
const char *orca_presets_templates(void *p, const char *json_text)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle) { ps.fail(ORCA_INVALID_CONFIG, "Presets not loaded"); return nullptr; }
    try {
        const json j = json::parse(json_text ? json_text : "", nullptr, false);
        const Preset *printer = ps.bundle->printers.find_preset(j.is_object() ? j.value("printer", "") : "", false);
        if (!printer) { ps.fail(ORCA_INVALID_CONFIG, "Unknown printer"); return nullptr; }
        const PresetWithVendorProfile active = ps.bundle->printers.get_preset_with_vendor_profile(*printer);
        auto list = [&](const PresetCollection &c) {
            json a = json::array();
            for (const Preset &pr : c)
                if (!pr.is_default && pr.is_visible && is_compatible_with_printer(c.get_preset_with_vendor_profile(pr), active))
                    a.push_back(preset_entry(pr));
            return a;
        };
        return ps.ret(json{{"processes", list(ps.bundle->prints)}, {"filaments", list(ps.bundle->filaments)}}.dump());
    } catch (const std::exception &ex) {
        ps.fail(ORCA_INVALID_CONFIG, "Could not list templates", ex.what());
        return nullptr;
    }
}

// Desktop's Create Printer dialog: a custom printer (a user preset with no parent) named
// "<model> <nozzle> nozzle", from a template printer's settings, with copies of the chosen process
// and filament presets made for it alone. Selects it.
// The user's print and filament presets made for a printer model: those whose compatible printers
// name one of its printer presets (a variant shares them). {model} → {processes[], filaments[]}
const char *orca_presets_linked(void *p, const char *json_text)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle) { ps.fail(ORCA_INVALID_CONFIG, "Presets not loaded"); return nullptr; }
    try {
        const json j = json::parse(json_text ? json_text : "", nullptr, false);
        const std::string model = j.is_object() ? j.value("model", "") : "";
        std::set<std::string> printers;
        for (const Preset &pr : ps.bundle->printers)
            if (!pr.is_default && !model.empty() && pr.config.opt_string("printer_model") == model) printers.insert(pr.name);
        auto list = [&](const PresetCollection &c) {
            json a = json::array();
            for (const Preset &pr : c) {
                if (pr.is_default || !pr.is_user()) continue;
                const auto *l = pr.config.option<ConfigOptionStrings>("compatible_printers");
                if (l && std::any_of(l->values.begin(), l->values.end(), [&](const std::string &n) { return printers.count(n) > 0; }))
                    a.push_back(preset_entry(pr));
            }
            return a;
        };
        return ps.ret(json{{"processes", list(ps.bundle->prints)}, {"filaments", list(ps.bundle->filaments)}}.dump());
    } catch (const std::exception &ex) {
        ps.fail(ORCA_INVALID_CONFIG, "Could not list the presets", ex.what());
        return nullptr;
    }
}

// {model, nozzle, template, from_template, area?[], height?, bed_from?, link?, processes[], filaments[], share?[], overwrite?}
//   → {printer, created[], process, filament}; without overwrite, existing names fail with detail =
//   JSON list of them. `share`: user presets the new printer is added to (their compatible
//   printers) instead of copied; then processes[] / filaments[] may be empty.
const char *orca_presets_create_printer(void *p, const char *json_text)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle) { ps.fail(ORCA_INVALID_CONFIG, "Presets not loaded"); return nullptr; }
    try {
        const json j = json::parse(json_text ? json_text : "", nullptr, false);
        if (!j.is_object()) { ps.fail(ORCA_INVALID_CONFIG, "Bad request"); return nullptr; }
        PresetBundle &b = *ps.bundle;
        const std::string model = j.value("model", "");
        std::string nozzle = j.value("nozzle", "0.4");
        std::replace(nozzle.begin(), nozzle.end(), ',', '.');
        const float nozzle_dia = std::stof(nozzle);
        const Preset *tpl = b.printers.find_preset(j.value("template", ""), false);
        if (model.empty() || !tpl || !(nozzle_dia > 0)) { ps.fail(ORCA_INVALID_CONFIG, "Missing printer model, nozzle or template"); return nullptr; }
        const std::string name = model + " " + nozzle + " nozzle";
        auto pick = [](const PresetCollection &c, const json &names) {
            std::vector<const Preset *> out;
            for (const auto &n : names) if (const Preset *pr = c.find_preset(n.get<std::string>(), false)) out.push_back(pr);
            return out;
        };
        std::vector<const Preset *> filaments = pick(b.filaments, j.value("filaments", json::array()));
        std::vector<const Preset *> processes = pick(b.prints, j.value("processes", json::array()));
        // The user's presets the new printer shares (a variant: those of its model), not copies.
        std::vector<std::string> share_filaments, share_processes;
        for (const auto &n : j.value("share", json::array())) {
            const std::string sn = n.get<std::string>();
            if (const Preset *pr = b.filaments.find_preset(sn, false); pr && pr->is_user()) share_filaments.push_back(sn);
            else if (const Preset *pr2 = b.prints.find_preset(sn, false); pr2 && pr2->is_user()) share_processes.push_back(sn);
        }
        if ((filaments.empty() && share_filaments.empty()) || (processes.empty() && share_processes.empty())) {
            ps.fail(ORCA_INVALID_CONFIG, "Select at least one filament and one process preset");
            return nullptr;
        }

        // What the new printer starts with is chosen by these (see below).
        const std::string used_process = b.prints.get_selected_preset_name(), def_process = str_opt(tpl->config, "default_print_profile");
        const std::string used_filament = b.filament_presets.empty() ? std::string() : b.filament_presets.front();
        const auto *tpl_fil = tpl->config.option<ConfigOptionStrings>("default_filament_profile");
        const std::string def_filament = tpl_fil && !tpl_fil->values.empty() ? tpl_fil->values.front() : std::string();

        // Names that exist already: the caller asks before replacing them (desktop asks too).
        auto clone_name = [&](const Preset *pr) { return base_name(pr->name) + " @" + name; };
        if (!j.value("overwrite", false)) {
            json existing = json::array();
            if (b.printers.find_preset(name, false)) existing.push_back(name);
            for (const Preset *pr : filaments) if (b.filaments.find_preset(clone_name(pr), false)) existing.push_back(clone_name(pr));
            for (const Preset *pr : processes) if (b.prints.find_preset(clone_name(pr), false)) existing.push_back(clone_name(pr));
            if (!existing.empty()) { ps.fail(ORCA_INVALID_CONFIG, "Presets with these names exist", existing.dump()); return nullptr; }
        }

        // Cloning inserts into the collections, which invalidates the pointers above: names first.
        json created = json::array({name});
        for (const Preset *pr : filaments) created.push_back(clone_name(pr));
        for (const Preset *pr : processes) created.push_back(clone_name(pr));
        std::vector<std::string> failures;
        b.filaments.clone_presets_for_printer(filaments, failures, name, [&](std::string n) { return new_filament_id(b.filaments, n); }, true);
        // From a template the process copies are adapted to the nozzle (desktop does this for templates only).
        std::vector<Preset> adapted;
        if (j.value("from_template", false)) {
            adapted.reserve(processes.size());
            for (const Preset *pr : processes) { adapted.push_back(*pr); adapt_process_to_nozzle(adapted.back().config, nozzle_dia); }
            processes.clear();
            for (const Preset &pr : adapted) processes.push_back(&pr);
        }
        failures.clear();
        b.prints.clone_presets_for_printer(processes, failures, name, nullptr, true);

        // link: a variant of the user's own printer of this model is a child of its root (that printer,
        // or the one it is based on), as "Save as" makes one, so it follows the root's later changes,
        // the bed too. Otherwise the variant is a printer of its own (desktop).
        std::string root;
        if (j.value("link", false))
            if (const Preset *r = b.printers.get_preset_base(*tpl);
                r && r->is_user() && r->inherits().empty() && r->name != name && r->config.opt_string("printer_model") == model)
                root = r->name;

        Preset printer = *tpl;
        DynamicPrintConfig &cfg = printer.config;
        if (const Preset *bed = root.empty() ? b.printers.find_preset(j.value("bed_from", ""), false) : nullptr)
            cfg.apply_only(bed->config, {"printable_area", "printable_height", "bed_custom_model", "bed_custom_texture"}, true);
        if (j.contains("area")) cfg.option<ConfigOptionPoints>("printable_area", true)->deserialize(j["area"].get<std::string>());
        if (j.contains("height")) cfg.option<ConfigOptionFloat>("printable_height", true)->value = j["height"].get<double>();
        cfg.option<ConfigOptionString>("printer_model", true)->value = model;
        cfg.option<ConfigOptionString>("printer_variant", true)->value = nozzle;
        if (auto *nd = cfg.option<ConfigOptionFloats>("nozzle_diameter", true)) std::fill(nd->values.begin(), nd->values.end(), nozzle_dia);
        if (!root.empty()) printer.inherits() = root;
        b.printers.save_current_preset(name, /*detach=*/root.empty(), false, &printer);
        // Shared presets name the new printer among their compatible printers, in their files too.
        // A preset for every printer already fits it.
        using Share = std::pair<PresetCollection *, const std::vector<std::string> *>;
        for (const auto &[c, names] : {Share(&b.filaments, &share_filaments), Share(&b.prints, &share_processes)})
            for (const std::string &sn : *names) {
                // The stored preset (find_preset hands out the edited copy of a selected one).
                Preset *pr = c->find_preset(sn, false, true);
                if (!pr) continue;
                std::vector<std::string> list = pr->config.option<ConfigOptionStrings>("compatible_printers", true)->values;
                if (list.empty() || std::find(list.begin(), list.end(), name) != list.end()) continue;
                list.push_back(name);
                set_compatible(*c, *pr, "compatible_printers", list);
            }
        for (Preset &pr : b.printers)
            if (!pr.is_default) pr.is_visible = true;
        b.printers.select_preset_by_name(name, true);
        b.update_multi_material_filament_presets();
        b.update_compatible(PresetSelectCompatibleType::Always);
        // Start with the presets made for it, or else the first it shares. Of those made for it,
        // the one of the settings in use before, or else of the template's default.
        auto start_with = [&](size_t from, size_t count, const std::string &used, const std::string &def) {
            for (const std::string &want : {used, def})
                for (size_t i = from; i < from + count; ++i)
                    if (const std::string n = created[i].get<std::string>(); !want.empty() && base_name(n) == base_name(want)) return n;
            return created[from].get<std::string>();
        };
        const std::string process = !processes.empty() ? start_with(1 + filaments.size(), processes.size(), used_process, def_process) : share_processes.front();
        const std::string filament = !filaments.empty() ? start_with(1, filaments.size(), used_filament, def_filament) : share_filaments.front();
        b.prints.select_preset_by_name(process, true);
        b.filament_presets.assign(b.filament_presets.empty() ? 1 : b.filament_presets.size(), filament);
        b.filaments.select_preset_by_name(filament, true);
        b.update_compatible(PresetSelectCompatibleType::Never);
        return ps.ret(json{{"printer", name}, {"created", created}, {"process", process}, {"filament", filament}}.dump());
    } catch (const std::exception &ex) {
        ps.fail(ORCA_INVALID_CONFIG, "Could not create the printer", ex.what());
        return nullptr;
    }
}

// Desktop's Create Filament dialog, its lists: every filament preset with its filament id, type
// (its own or its parent's), printers (compatible_printers) and parent.
const char *orca_presets_filament_list(void *p)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle) { ps.fail(ORCA_INVALID_CONFIG, "Presets not loaded"); return nullptr; }
    json a = json::array();
    PresetCollection &c = ps.bundle->filaments;
    for (const Preset &pr : c) {
        if (pr.is_default || pr.filament_id.empty() || pr.filament_id == "null") continue;
        const Preset *parent = pr.inherits().empty() ? nullptr : c.find_preset(pr.inherits(), false, true);
        const auto *types = (parent ? parent : &pr)->config.option<ConfigOptionStrings>("filament_type");
        const auto *printers = pr.config.option<ConfigOptionStrings>("compatible_printers");
        a.push_back({{"name", pr.name}, {"alias", pr.alias}, {"filament_id", pr.filament_id}, {"user", pr.is_user()}, {"visible", pr.is_visible},
                     {"inherits", pr.inherits()}, {"type", types && !types->values.empty() ? types->values.front() : std::string()},
                     {"printers", printers ? printers->values : std::vector<std::string>()}});
    }
    return ps.ret(a.dump());
}

// Desktop's Create Filament: "<name> @<printer>" copies of the chosen presets, one per printer, for
// that printer alone, all with one new filament id. {name, vendor, type, items[{printer, preset}],
// overwrite?} → {created[]}; without overwrite, existing names fail with detail = JSON list.
const char *orca_presets_create_filament(void *p, const char *json_text)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle) { ps.fail(ORCA_INVALID_CONFIG, "Presets not loaded"); return nullptr; }
    try {
        const json j = json::parse(json_text ? json_text : "", nullptr, false);
        if (!j.is_object()) { ps.fail(ORCA_INVALID_CONFIG, "Bad request"); return nullptr; }
        PresetCollection &c = ps.bundle->filaments;
        const std::string name = j.value("name", ""), vendor = j.value("vendor", ""), type = j.value("type", "");
        std::vector<std::pair<std::string, std::string>> items;   // printer, template preset
        for (const auto &it : j.value("items", json::array())) items.emplace_back(it.value("printer", ""), it.value("preset", ""));
        if (name.empty() || vendor.empty() || type.empty() || items.empty()) { ps.fail(ORCA_INVALID_CONFIG, "Missing filament name, vendor, type or printers"); return nullptr; }
        json created = json::array(), existing = json::array();
        for (const auto &[printer, preset] : items) {
            if (!c.find_preset(preset, false)) { ps.fail(ORCA_INVALID_CONFIG, "Unknown filament preset", preset); return nullptr; }
            created.push_back(name + " @" + printer);
            if (c.find_preset(name + " @" + printer, false)) existing.push_back(name + " @" + printer);
        }
        if (!existing.empty() && !j.value("overwrite", false)) { ps.fail(ORCA_INVALID_CONFIG, "Presets with these names exist", existing.dump()); return nullptr; }
        const std::string id = new_filament_id(c, name);
        const std::string keep = c.get_selected_preset_name();
        for (const auto &[printer, preset] : items) {
            DynamicConfig cfg;
            cfg.set_key_value("filament_vendor", new ConfigOptionStrings({vendor}));
            cfg.set_key_value("compatible_printers", new ConfigOptionStrings({printer}));
            cfg.set_key_value("filament_type", new ConfigOptionStrings({type}));
            std::vector<std::string> failures;
            // Looked up again each time: cloning inserts into the collection.
            const Preset *tpl = c.find_preset(preset, false);
            c.clone_presets_for_filament(tpl, failures, name, id, cfg, printer, true);
        }
        c.select_preset_by_name(keep, false);
        ps.bundle->update_compatible(PresetSelectCompatibleType::Never);
        return ps.ret(json{{"created", created}, {"filament_id", id}}.dump());
    } catch (const std::exception &ex) {
        ps.fail(ORCA_INVALID_CONFIG, "Could not create the filament", ex.what());
        return nullptr;
    }
}


// The settings of any preset of one type, as orca_presets_values gives the edited one's: for
// comparing presets side by side. {type, name} → {name, values{}}; the selected preset as edited
// (PresetCollection::find_preset, as desktop's Compare presets dialog takes it).
const char *orca_presets_preset_values(void *p, const char *json_text)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle) { ps.fail(ORCA_INVALID_CONFIG, "Presets not loaded"); return nullptr; }
    const json j = json::parse(json_text ? json_text : "", nullptr, false);
    PresetCollection *c = j.is_object() ? collection(*ps.bundle, j.value("type", "")) : nullptr;
    if (!c) { ps.fail(ORCA_INVALID_CONFIG, "Must be {type, name}"); return nullptr; }
    const Preset *pr = c->find_preset(j.value("name", ""));
    if (!pr) { ps.fail(ORCA_INVALID_CONFIG, "Preset not found", j.value("name", "")); return nullptr; }
    json values = json::object();
    for (const std::string &key : pr->config.keys()) {
        const ConfigOption *o = pr->config.option(key);
        if (o->is_vector()) values[key] = static_cast<const ConfigOptionVectorBase *>(o)->vserialize();
        else values[key] = o->serialize();
    }
    return ps.ret(json{{"name", pr->name}, {"values", std::move(values)}}.dump());
}

// Every visible preset of one type, each with "compatible" for the selected printer (and print):
// desktop's Compare presets lists them all with "Show all presets (including incompatible)".
// {type} → [entry…]
const char *orca_presets_all(void *p, const char *json_text)
{
    Presets &ps = *as_presets(p);
    if (!ps.bundle) { ps.fail(ORCA_INVALID_CONFIG, "Presets not loaded"); return nullptr; }
    const json j = json::parse(json_text ? json_text : "", nullptr, false);
    PresetCollection *c = j.is_object() ? collection(*ps.bundle, j.value("type", "")) : nullptr;
    if (!c) { ps.fail(ORCA_INVALID_CONFIG, "Must be {type}"); return nullptr; }
    json a = json::array();
    for (const Preset &pr : *c) {
        if (pr.is_default || !pr.is_visible) continue;
        json e = preset_entry(pr);
        e["compatible"] = pr.is_compatible;
        a.push_back(std::move(e));
    }
    return ps.ret(a.dump());
}

// orca_presets_load for presets kept aside (another vendor's, to compare with): the data folder
// the other handles save to stays as it was (orca_presets_load moves it to `dir`).
int orca_presets_load_aside(void *p, const char *dir)
{
    const std::string data = data_dir(), resources = resources_dir();
    const int rc = orca_presets_load(p, dir);
    if (!data.empty()) set_data_dir(data);
    if (!resources.empty()) set_resources_dir(resources);
    return rc;
}

} // extern "C"
