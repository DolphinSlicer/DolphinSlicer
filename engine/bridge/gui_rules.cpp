// Which settings apply: runs the desktop's toggle rules (generated gui_rules_generated.cpp) on a
// copy of the edited preset and reports disabled/hidden options, renamed labels and restricted
// enum choices. See gui_rules_shim.hpp.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
#include "gui_rules.hpp"
#include "gui_rules_shim.hpp"

namespace Slic3r { namespace GUI {

GUI_App &wxGetApp()
{
    static GUI_App app;
    return app;
}

}} // namespace Slic3r::GUI

namespace {

using namespace Slic3r;
using namespace Slic3r::GUI;

std::vector<std::string> enum_subset(const char *key, const std::vector<int> &ids)
{
    const ConfigOptionDef *def = print_config_def.get(key);
    std::vector<std::string> out;
    for (int i : ids) out.push_back(def->enum_values[i]);
    return out;
}

// Choice lists the desktop narrows in TabPrint::toggle_options() by editing the combo boxes
// (Tab.cpp, after the toggle_print_fff_options call). Ported by hand: that part is widget code.
nlohmann::json print_enums(PresetBundle &b, const DynamicPrintConfig &cfg)
{
    nlohmann::json enums = nlohmann::json::object();
    enums["support_style"] = is_tree(cfg.opt_enum<SupportType>("support_type"))
        ? enum_subset("support_style", {smsDefault, smsTreeSlim, smsTreeStrong, smsTreeHybrid, smsTreeOrganic})
        : enum_subset("support_style", {smsDefault, smsGrid, smsSnug});

    const auto *belt = b.printers.get_edited_preset().config.option<ConfigOptionBool>("belt_printer");
    const bool offer_leading_edge = (belt && belt->value) || cfg.opt_enum<BrimType>("brim_type") == btLeadingEdgeOnly;
    std::vector<std::string> brim;
    for (const std::string &v : print_config_def.get("brim_type")->enum_values)
        if (v != "leading_edge_only" || offer_leading_edge) brim.push_back(v);
    enums["brim_type"] = brim;

    enums["wipe_tower_wall_type"] = b.is_bbl_vendor() ? enum_subset("wipe_tower_wall_type", {wtwRectangle, wtwRib})
                                                      : enum_subset("wipe_tower_wall_type", {wtwRectangle, wtwCone, wtwRib});
    return enums;
}

} // namespace

nlohmann::json orca_option_states(PresetBundle &b, const std::string &type, int variant)
{
    OptionStates out;
    nlohmann::json enums = nlohmann::json::object();
    wxGetApp().preset_bundle = &b;

    if (type == "print") {
        DynamicPrintConfig cfg = b.prints.get_edited_preset().config;
        ConfigManipulation cm(out);
        cm.set_is_BBL_Printer(b.is_bbl_vendor());
        // is_global_config: the settings page edits the preset, not an object's overrides.
        cm.toggle_print_fff_options(&cfg, variant, true);
        enums = print_enums(b, b.prints.get_edited_preset().config);
    } else if (type == "filament") {
        DynamicPrintConfig cfg = b.filaments.get_edited_preset().config;
        TabFilament tab(out, b, cfg, b.filaments, variant);
        for (const char *page : {"Filament", "Cooling", "Setting Overrides", "Multimaterial"}) {
            tab.set_page(page);
            tab.toggle_options();
        }
    } else if (type == "printer") {
        DynamicPrintConfig cfg = b.printers.get_edited_preset().config;
        TabPrinter tab(out, b, cfg, b.printers, variant);
        for (const char *page : {"Basic information", "Machine G-code", "Multimaterial", "Extruder", "Motion ability"}) {
            tab.set_page(page);
            tab.toggle_options();
        }
    }
    wxGetApp().preset_bundle = nullptr;

    return {{"disabled", out.disabled}, {"hidden", out.hidden}, {"labels", out.labels}, {"enums", enums}};
}
