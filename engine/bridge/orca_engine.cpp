// DolphinSlicer engine bridge: the C API in orca_engine.h over OrcaSlicer's libslic3r.
//
// The slicing sequence deliberately replays what desktop OrcaSlicer's CLI does for one plate
// (src/OrcaSlicer.cpp, CLI::run, v2.5.0), because matching its G-code is the acceptance
// criterion. Each step below cites the CLI code it mirrors. The CLI's preset merging (≈3000
// lines) is NOT replayed: the engine receives the already-merged config (the CLI's
// --export-settings output is exactly that merged config, written before slicing).
//
// SPDX-License-Identifier: AGPL-3.0-or-later
#include "orca_engine.h"
#include "engine_internal.hpp"

#include <libslic3r/libslic3r.h>
#include <libslic3r/Arrange.hpp>
#include <libslic3r/ExclusionVolumeGeometry.hpp>
#include <libslic3r/ModelArrange.hpp>
#include <libslic3r/BuildVolume.hpp>
#include <libslic3r/Config.hpp>
#include <libslic3r/CustomGCode.hpp>
#include <libslic3r/Format/bbs_3mf.hpp>
#include <libslic3r/GCode/GCodeProcessor.hpp>
#include <libslic3r/GCode/ThumbnailData.hpp>
#include <libslic3r/Model.hpp>
#include <libslic3r/Preset.hpp>
#include <libslic3r/Print.hpp>
#include <libslic3r/PrintConfig.hpp>
#include <libslic3r/Utils.hpp>
#include <libslic3r/calib.hpp>
#include <libslic3r_version.h>

#include <boost/algorithm/string/predicate.hpp>
#include <boost/filesystem.hpp>
#include <boost/log/core.hpp>
#include <boost/log/expressions.hpp>
#include <boost/log/trivial.hpp>
#include <boost/nowide/fstream.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cfloat>
#include <cmath>
#include <atomic>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <vector>

#ifdef __EMSCRIPTEN_PTHREADS__
#include <pthread.h>
#else
#include <emscripten/em_asm.h>
#endif

#ifndef DOLPHIN_SLICER_ORCA_SHA
#define DOLPHIN_SLICER_ORCA_SHA "unknown"
#endif

using namespace Slic3r;
using json = nlohmann::json;

namespace {

struct Engine
{
    // Inputs
    Model              model;
    PlateDataPtrs      plate_data;
    std::vector<Preset *> project_presets;
    bool               is_bbl_3mf = false;
    DynamicPrintConfig print_config;   // the CLI's m_print_config
    DynamicPrintConfig extra_config;   // the CLI's m_extra_config (no command-line overrides here)
    bool               has_model  = false;
    bool               has_config = false;
    // Desktop's calibration tests (orca_set_calib): what G-code export does for them.
    Calib_Params       calib;

    // Slice state
    std::unique_ptr<Print>  print;
    GCodeProcessorResult    gcode_result;
    std::atomic<int>        status{ORCA_OK};
    std::atomic<bool>       running{false};
    std::atomic<bool>       cancel_requested{false};
    int                     plate = 1;
    std::string             out_path;

    // Reporting (progress is written by the slicing thread, read by the host thread)
    std::mutex  mtx;
    int         progress_percent = 0;
    std::string progress_message;
    std::string error_json  = R"({"code":0,"message":"","detail":""})";
    std::string result_json = "{}";
    std::string scratch;   // backing store for returned strings
    // The last orca_export_preview's vertices (read by the host straight from memory).
    std::unique_ptr<char[]> preview;
    size_t                  preview_bytes = 0;

#ifdef __EMSCRIPTEN_PTHREADS__
    pthread_t thread{};
    bool      thread_joinable = false;
#endif

    ~Engine()
    {
        drop_model_backup();
        release_PlateData_list(plate_data);
        for (Preset *p : project_presets) delete p;
    }

    // Model::get_backup_path() (called while loading a 3MF) creates a temp folder for the
    // desktop app's project autosave, and ~Model() then hands its removal to the autosave
    // manager, which starts a background thread. The engine never autosaves: remove the folder
    // here so ~Model() skips the manager (no thread; in the single-threaded build creating one
    // throws inside the destructor and terminates). A model that is destroyed inside the loader,
    // when reading the file fails, is covered by the Orca patch to ~Model().
    void drop_model_backup() { model.remove_backup_path_if_exist(); }

    int fail(int code, const std::string &message, const std::string &detail = {})
    {
        std::lock_guard<std::mutex> lock(mtx);
        error_json = json{{"code", code}, {"message", message}, {"detail", detail}}.dump();
        return code;
    }
    const char *ret(std::string s) { scratch = std::move(s); return scratch.c_str(); }
};

Engine *as_engine(void *p) { return static_cast<Engine *>(p); }

// The desktop app centres every object loaded from a mesh file around its own origin
// (Plater::load_files → ModelObject::center_around_origin), so an instance offset is the
// position of the object's bounding-box centre. Do the same, so layouts mean the same thing.
void center_new_objects(Model &model, size_t first)
{
    for (size_t i = first; i < model.objects.size(); ++i) {
        model.objects[i]->center_around_origin(false);
        // center_around_origin() leaves the cached raw-mesh bounding box at the old position.
        model.objects[i]->invalidate_bounding_box();
    }
}

json matrix_json(const Transform3d &m)
{
    json a = json::array();
    for (int c = 0; c < 4; ++c)
        for (int r = 0; r < 4; ++r) a.push_back(m(r, c));   // column-major, like three.js
    return a;
}

bool matrix_from_json(const json &j, Transform3d &m)
{
    if (!j.is_array() || j.size() != 16) return false;
    for (int c = 0; c < 4; ++c)
        for (int r = 0; r < 4; ++r) {
            const json &v = j[c * 4 + r];
            if (!v.is_number()) return false;
            m(r, c) = v.get<double>();
        }
    return true;
}

void quiet_logging()
{
    // libslic3r logs a lot at info/debug level; keep warnings and errors only.
    static bool done = false;
    if (done) return;
    done = true;
    boost::log::core::get()->set_filter(boost::log::trivial::severity >= boost::log::trivial::warning);
}

// ── slicing (runs on the calling thread in ST, on a pthread in MT) ───────────────────────
// Desktop renders the G-code thumbnails with OpenGL (Plater::priv::generate_thumbnails). The engine
// has no OpenGL: the host renders them and writes each as raw RGBA, bottom row first as
// glReadPixels returns it, to THUMBS_DIR/<width>x<height>.rgba. A size without a file is left out.
static const char *const THUMBS_DIR = "/thumbs";

ThumbnailsList read_thumbnails(const ThumbnailsParams &params)
{
    ThumbnailsList out;
    for (const Vec2d &size : params.sizes) {
        const long w = std::lround(size.x()), h = std::lround(size.y());
        if (w <= 0 || h <= 0) continue;
        boost::nowide::ifstream f(std::string(THUMBS_DIR) + "/" + std::to_string(w) + "x" + std::to_string(h) + ".rgba", std::ios::binary);
        if (!f) continue;
        ThumbnailData data;
        data.set(unsigned(w), unsigned(h));
        f.read(reinterpret_cast<char *>(data.pixels.data()), std::streamsize(data.pixels.size()));
        if (f.gcount() == std::streamsize(data.pixels.size()) && data.is_valid()) out.push_back(std::move(data));
    }
    return out;
}

int do_slice(Engine &e)
{
    const int plate_idx = e.plate - 1;
    try {
        // CLI: model.curr_plate_index = index
        e.model.curr_plate_index = plate_idx;

        // CLI: PartPlateList::load_from_3mf_structure → PartPlate::config(); the per-plate config
        // overrides from the 3MF. Then: new_print_config = m_print_config + plate config + extra.
        DynamicPrintConfig cfg = e.print_config;
        const PlateData *pd = nullptr;
        for (const PlateData *p : e.plate_data)
            if (p && p->plate_index == plate_idx) pd = p;
        if (pd) cfg.apply(pd->config);
        cfg.apply(e.extra_config, true);

        // CLI: final_filament_maps sized to filament_count, all 1 on single-extruder printers.
        const int filament_count = int(cfg.option<ConfigOptionStrings>("filament_colour", true)->values.size());
        const int extruder_count = int(cfg.option<ConfigOptionFloats>("nozzle_diameter", true)->values.size());
        std::vector<int> &maps = cfg.option<ConfigOptionInts>("filament_map", true)->values;
        if (int(maps.size()) < filament_count) maps.resize(filament_count, 1);
        if (extruder_count == 1)
            for (int i = 0; i < filament_count; ++i) maps[i] = 1;
        if (!cfg.has("nozzle_volume_type"))
            cfg.option<ConfigOptionEnumsGeneric>("nozzle_volume_type", true)->values.resize(extruder_count, nvtStandard);

        // CLI: BuildVolume(part_plate->get_shape(), print_height, extruder areas, heights) and
        // model.update_print_volume_state(). Plate 1 sits at the origin.
        // TODO(phase 1+): plates > 1 need PartPlateList::compute_origin().
        if (plate_idx != 0)
            return e.fail(ORCA_INVALID_INPUT, "Only plate 1 is supported in this engine version.");
        Pointfs printable_area = cfg.opt<ConfigOptionPoints>("printable_area")->values;
        // PartPlate::set_shapes is called with make_counter_clockwise(current_printable_area).
        {
            Polygon poly;
            for (const Vec2d &p : printable_area) poly.points.emplace_back(scaled(p));
            if (poly.is_clockwise()) std::reverse(printable_area.begin(), printable_area.end());
        }
        std::vector<Pointfs> extruder_areas;
        if (auto *o = cfg.opt<ConfigOptionPointsGroups>("extruder_printable_area"))
            extruder_areas = o->values;
        std::vector<double> extruder_heights;
        if (auto *o = cfg.opt<ConfigOptionFloatsNullable>("extruder_printable_height"))
            extruder_heights = o->values;
        BuildVolume build_volume(printable_area, cfg.opt_float("printable_height"), extruder_areas, extruder_heights);
        if (e.model.update_print_volume_state(build_volume) == 0)
            return e.fail(ORCA_EMPTY_PLATE, "No object is fully inside the print volume.");

        // PartPlateList creates one Print per plate: set_index, set_plate_origin, plate name.
        // (e.print is created by orca_slice_start on the host thread, so orca_cancel never races
        // with its construction.)
        Print &print = *e.print;
        print.set_plate_index(plate_idx);
        print.set_plate_origin(Vec3d(0, 0, 0));
        if (pd) print.set_plate_name(pd->plate_name);
        print.set_status_callback([&e](const PrintBase::SlicingStatus &s) {
            if (s.percent < 0) return;
            {
                std::lock_guard<std::mutex> lock(e.mtx);
                e.progress_percent = s.percent;
                e.progress_message = s.text;
            }
#ifndef __EMSCRIPTEN_PTHREADS__
            // Single-threaded: the host's JS thread is busy inside orca_slice_start and cannot
            // poll, so push progress to an optional Module.onOrcaProgress(percent, message).
            EM_ASM({ if (Module['onOrcaProgress']) Module['onOrcaProgress']($0, UTF8ToString($1)); }, s.percent, s.text.c_str());
#endif
        });
        if (e.cancel_requested.load()) return e.fail(ORCA_CANCELLED, "Cancelled");

        // The pressure advance pattern test is G-code of its own on each layer, made for every
        // object (its "handle") before slicing, as desktop's Plater::_calib_pa_pattern_gen_gcode.
        const std::string &printer_model = cfg.opt_string("printer_model", true);
        const bool is_bbl = boost::starts_with(printer_model, "Bambu Lab");
        if (e.calib.mode == CalibMode::Calib_PA_Pattern && !e.model.objects.empty()) {
            CalibPressureAdvancePattern pattern(e.calib, cfg, is_bbl, *e.model.objects.front(), Vec3d::Zero());
            std::vector<CustomGCode::Info> mgc;
            for (const ModelObject *obj : e.model.objects)
                mgc.emplace_back(pattern.generate_custom_gcodes(cfg, is_bbl, *obj, Vec3d::Zero()));
            CustomGCode::Info &pcgc = e.model.plates_custom_gcodes[plate_idx];
            pcgc = std::move(mgc[0]);
            for (size_t i = 0; i < pcgc.gcodes.size(); i++)
                for (size_t k = 1; k < mgc.size(); ++k)
                    if (i < mgc[k].gcodes.size()) pcgc.gcodes[i].extra += mgc[k].gcodes[i].extra;
        }

        // CLI: print->apply(model, new_print_config); is_BBL_printer from printer_model.
        print.apply(e.model, cfg);
        print.is_BBL_printer() = is_bbl;
        print.set_calib_params(e.calib);

        std::vector<StringObjectException> warnings;
        print.set_check_multi_filaments_compatibility(true);
        StringObjectException err = print.validate(&warnings);
        if (!err.string.empty())
            return e.fail(ORCA_VALIDATE_ERROR, err.string);
        if (print.empty())
            return e.fail(ORCA_EMPTY_PLATE, "Nothing to print on this plate.");

        print.process();
        e.gcode_result.reset();
        print.export_gcode(e.out_path, &e.gcode_result, read_thumbnails);

        const PrintStatistics &ps = print.print_statistics();
        const auto &normal = e.gcode_result.print_statistics.modes[0];
        json r = {
            {"plate", e.plate},
            {"gcode", e.out_path},
            {"layers", print.objects().empty() ? 0 : int(e.gcode_result.moves.empty() ? 0 : 1)},
            {"print_time_s", normal.time},
            {"filament_mm", ps.total_used_filament},
            {"filament_cm3", ps.total_extruded_volume / 1000.0},
            {"filament_g", ps.total_weight},
            {"cost", ps.total_cost},
            {"warnings", json::array()},
        };
        for (const StringObjectException &w : warnings) r["warnings"].push_back(w.string);
        // Desktop's name for the file (the "Filename format" setting, named after the first
        // object as an unsaved project is); none when the template fails.
        try { r["file_name"] = print.output_filename(""); } catch (const std::exception &) {}
        {
            std::lock_guard<std::mutex> lock(e.mtx);
            e.result_json      = r.dump();
            e.progress_percent = 100;
        }
        return ORCA_OK;
    } catch (const CanceledException &) {
        return e.fail(ORCA_CANCELLED, "Cancelled");
    } catch (const std::bad_alloc &) {
        return e.fail(ORCA_OOM, "Out of memory", "The browser could not provide more memory for this slice.");
    } catch (const SlicingErrors &ex) {
        return e.fail(ORCA_SLICE_FAILED, e.print ? e.print->slicing_errors_message(ex) : std::string(ex.what()));
    } catch (const std::exception &ex) {
        return e.fail(ORCA_SLICE_FAILED, ex.what());
    } catch (...) {
        return e.fail(ORCA_INTERNAL, "Unknown error");
    }
}

#ifdef __EMSCRIPTEN_PTHREADS__
void *slice_thread(void *arg)
{
    Engine &e = *static_cast<Engine *>(arg);
    e.status.store(do_slice(e));
    e.running.store(false);
    return nullptr;
}
#endif

// ── Preview ──────────────────────────────────────────────────────────────────────────────

// libvgcode's EGCodeExtrusionRole and EMoveType numbers (desktop's LibVGCodeWrapper.cpp convert()).
uint8_t preview_role(ExtrusionRole role)
{
    switch (role) {
    case erPerimeter: return 1;
    case erExternalPerimeter: return 2;
    case erOverhangPerimeter: return 3;
    case erInternalInfill: return 4;
    case erSolidInfill: return 5;
    case erTopSolidInfill: return 6;
    case erIroning: return 7;
    case erBridgeInfill: return 8;
    case erGapFill: return 9;
    case erSkirt: return 10;
    case erSupportMaterial: return 11;
    case erSupportMaterialInterface: return 12;
    case erWipeTower: return 13;
    case erCustom: return 14;
    case erBottomSurface: return 15;
    case erInternalBridgeInfill: return 16;
    case erBrim: return 17;
    case erSupportTransition: return 18;
    case erMixed: return 19;
    default: return 0;
    }
}
// Same order in libslic3r and libvgcode (Noop … Extrude); anything else is libvgcode's COUNT.
uint8_t preview_type(EMoveType t) { return t <= EMoveType::Extrude ? uint8_t(t) : uint8_t(EMoveType::Count); }

// Desktop's starts_path() (LibVGCodeWrapper.cpp): where a phantom vertex at the previous move's
// position starts a new path.
bool starts_path(const GCodeProcessorResult::MoveVertex &prev, const GCodeProcessorResult::MoveVertex &curr, bool first_move)
{
    switch (curr.type) {
    case EMoveType::Retract: case EMoveType::Unretract: case EMoveType::Seam: case EMoveType::Tool_change:
    case EMoveType::Color_change: case EMoveType::Pause_Print: case EMoveType::Custom_GCode: return false;
    default: break;
    }
    return first_move || prev.type != curr.type || prev.extrusion_role != curr.extrusion_role ||
        prev.mm3_per_mm != curr.mm3_per_mm || prev.acceleration != curr.acceleration || prev.jerk != curr.jerk;
}

// Whether a G-code file has the tags of Bambu Lab printers (desktop reads those when a Bambu Lab
// printer is selected; Orca's own files say which printer they are for themselves).
bool has_bbl_tags(const std::string &path)
{
    boost::nowide::ifstream f(path, std::ios::binary);
    std::string line;
    while (std::getline(f, line)) {
        size_t i = line.find_first_not_of(" \t");
        if (i == std::string::npos || line[i] != ';') continue;
        i = line.find_first_not_of(' ', i + 1);
        if (i != std::string::npos && (line.compare(i, 8, "FEATURE:") == 0 || line.compare(i, 12, "CHANGE_LAYER") == 0)) return true;
        if (i != std::string::npos && (line.compare(i, 5, "TYPE:") == 0 || line.compare(i, 12, "LAYER_CHANGE") == 0)) return false;
    }
    return false;
}

} // namespace

namespace orca_bridge {
Model *engine_model(void *engine) { return engine ? &as_engine(engine)->model : nullptr; }
int engine_fail(void *engine, int code, const std::string &message, const std::string &detail) { return as_engine(engine)->fail(code, message, detail); }
} // namespace orca_bridge

extern "C" {

int orca_api_version(void) { return ORCA_API_VERSION; }

const char *orca_engine_info(void)
{
    static const std::string info = json{
        {"api", ORCA_API_VERSION},
        {"orca_version", SoftFever_VERSION},
        {"orca_sha", DOLPHIN_SLICER_ORCA_SHA},
#ifdef __EMSCRIPTEN_PTHREADS__
        {"threads", true}, {"build", "mt"},
#else
        {"threads", false}, {"build", "st"},
#endif
    }.dump();
    return info.c_str();
}

void *orca_create(void)
{
    quiet_logging();
    try { return new Engine(); } catch (...) { return nullptr; }
}

void orca_destroy(void *p)
{
    Engine *e = as_engine(p);
    if (!e) return;
#ifdef __EMSCRIPTEN_PTHREADS__
    if (e->thread_joinable) { orca_cancel(e); pthread_join(e->thread, nullptr); }
#endif
    delete e;
}

int orca_load_model(void *p, const char *path, const char *format)
{
    Engine &e = *as_engine(p);
    if (e.running.load()) return e.fail(ORCA_INTERNAL, "A slice is running");
    try {
        std::string file = path ? path : "";
        std::string fmt  = format ? format : "";
        const bool is_3mf = fmt == "3mf" || (fmt.empty() && boost::iends_with(file, ".3mf"));

        release_PlateData_list(e.plate_data);
        for (Preset *pr : e.project_presets) delete pr;
        e.project_presets.clear();

        DynamicPrintConfig        cfg_3mf;
        ConfigSubstitutionContext subs(ForwardCompatibilitySubstitutionRule::Enable);
        Semver                    file_version;
        // CLI: 3MF → LoadModel|LoadConfig|AddDefaultInstances|LoadAuxiliary; others → LoadModel|AddDefaultInstances.
        LoadStrategy strategy = is_3mf ? (LoadStrategy::LoadModel | LoadStrategy::LoadConfig | LoadStrategy::AddDefaultInstances |
                                          LoadStrategy::LoadAuxiliary)
                                       : (LoadStrategy::LoadModel | LoadStrategy::AddDefaultInstances);
        e.is_bbl_3mf = false;
        e.drop_model_backup();
        e.model = Model::read_from_file(file, &cfg_3mf, &subs, strategy, &e.plate_data, &e.project_presets, &e.is_bbl_3mf,
                                        &file_version, nullptr, nullptr, nullptr, 0);
        if (e.model.objects.empty())
            return e.fail(ORCA_INVALID_INPUT, "The file contains no objects.");
        // Non-3MF inputs keep the loader's default instance at the origin. The host places them
        // with orca_set_layout (the web app arranges new objects itself).
        if (!is_3mf) center_new_objects(e.model, 0);
        e.has_model = true;
        return ORCA_OK;
    } catch (const std::bad_alloc &) {
        return e.fail(ORCA_OOM, "Out of memory while loading the model");
    } catch (const std::exception &ex) {
        return e.fail(ORCA_INVALID_INPUT, "Could not load the model", ex.what());
    }
}

int orca_add_model(void *p, const char *path, const char *format)
{
    Engine &e = *as_engine(p);
    if (e.running.load()) return e.fail(ORCA_INTERNAL, "A slice is running");
    if (!e.has_model) return orca_load_model(p, path, format);
    try {
        std::string file = path ? path : "";
        std::string fmt  = format ? format : "";
        const bool  is_3mf = fmt == "3mf" || (fmt.empty() && boost::iends_with(file, ".3mf"));
        DynamicPrintConfig        cfg;
        ConfigSubstitutionContext subs(ForwardCompatibilitySubstitutionRule::Enable);
        // Geometry only, like the desktop app importing a model into an open project.
        Model added = Model::read_from_file(file, &cfg, &subs, LoadStrategy::LoadModel | LoadStrategy::AddDefaultInstances);
        added.remove_backup_path_if_exist();
        if (added.objects.empty())
            return e.fail(ORCA_INVALID_INPUT, "The file contains no objects.");
        const size_t first = e.model.objects.size();
        for (const ModelObject *o : added.objects) e.model.add_object(*o);
        if (!is_3mf) center_new_objects(e.model, first);
        return ORCA_OK;
    } catch (const std::bad_alloc &) {
        return e.fail(ORCA_OOM, "Out of memory while loading the model");
    } catch (const std::exception &ex) {
        return e.fail(ORCA_INVALID_INPUT, "Could not load the model", ex.what());
    }
}

const char *orca_model_info(void *p)
{
    Engine &e = *as_engine(p);
    json objs = json::array();
    for (const ModelObject *o : e.model.objects) {
        size_t parts = 0, modifiers = 0;
        for (const ModelVolume *v : o->volumes) (v->is_model_part() ? parts : modifiers)++;
        const BoundingBoxf3 bb = o->raw_mesh_bounding_box();
        const t_config_option_keys cfg_keys = o->config.keys();
        json inst = json::array();
        for (const ModelInstance *i : o->instances)
            inst.push_back({{"matrix", matrix_json(i->get_matrix())}, {"printable", i->printable}});
        objs.push_back({
            {"name", o->name},
            {"parts", parts},
            {"modifiers", modifiers},
            {"triangles", o->facets_count()},
            // Per-object overrides; "extruder" alone is what every loader sets by default.
            {"has_config", std::any_of(cfg_keys.begin(), cfg_keys.end(), [](const std::string &k) { return k != "extruder"; })},
            // Support enforcers or blockers painted (a desktop project's).
            {"painted", o->is_fdm_support_painted()},
            {"bbox", {{"min", {bb.min.x(), bb.min.y(), bb.min.z()}}, {"max", {bb.max.x(), bb.max.y(), bb.max.z()}}}},
            {"instances", inst},
        });
    }
    json plates = json::array();
    for (const PlateData *pd : e.plate_data)
        if (pd) plates.push_back({{"index", pd->plate_index + 1}, {"name", pd->plate_name}});
    return e.ret(json{{"objects", objs}, {"plates", plates}, {"bbl_3mf", e.is_bbl_3mf}}.dump());
}

// Binary mesh dump for the host's 3D view. Per object, in object coordinates (volume
// transforms applied, instance transform not): u32 vertex count, u32 triangle count,
// float32 xyz[vertices], u32 indices[3 * triangles]. Little-endian, objects in model order.
int orca_export_meshes(void *p, const char *out_path)
{
    Engine &e = *as_engine(p);
    try {
        boost::filesystem::create_directories(boost::filesystem::path(out_path).parent_path());
        boost::nowide::ofstream f(out_path, std::ios::binary);
        for (const ModelObject *o : e.model.objects) {
            const indexed_triangle_set its = o->raw_indexed_triangle_set();
            const uint32_t nv = uint32_t(its.vertices.size()), nt = uint32_t(its.indices.size());
            f.write(reinterpret_cast<const char *>(&nv), 4);
            f.write(reinterpret_cast<const char *>(&nt), 4);
            f.write(reinterpret_cast<const char *>(its.vertices.data()), std::streamsize(nv) * 12);
            f.write(reinterpret_cast<const char *>(its.indices.data()), std::streamsize(nt) * 12);
        }
        return f ? ORCA_OK : e.fail(ORCA_INTERNAL, "Could not write the mesh file");
    } catch (const std::bad_alloc &) {
        return e.fail(ORCA_OOM, "Out of memory while exporting meshes");
    } catch (const std::exception &ex) {
        return e.fail(ORCA_INTERNAL, "Could not export meshes", ex.what());
    }
}

// ── Preview ──────────────────────────────────────────────────────────────────────────────
int orca_process_gcode(void *p, const char *path)
{
    Engine &e = *as_engine(p);
    if (e.running.load()) return e.fail(ORCA_INTERNAL, "A slice is running");
    const bool bbl = GCodeProcessor::s_IsBBLPrinter;
    try {
        const std::string file = path ? path : "";
        // GCodeReader reads without checking that the file opened.
        if (!boost::filesystem::is_regular_file(file)) return e.fail(ORCA_INVALID_INPUT, "Could not read the G-code", "No such file");
        // As desktop's Plater::load_gcode.
        GCodeProcessor processor;
        processor.init_filament_maps_and_nozzle_type_when_import_only_gcode();
        GCodeProcessor::s_IsBBLPrinter = has_bbl_tags(file);
        processor.process_file(file);
        GCodeProcessor::s_IsBBLPrinter = bbl;
        e.gcode_result = std::move(processor.extract_result());
        // Desktop's editor loads the file's settings and colors the preview by their filament
        // colors (Plater::get_extruder_colors_from_plater_config).
        try {
            DynamicPrintConfig file_config;
            file_config.load_from_gcode_file(file, ForwardCompatibilitySubstitutionRule::EnableSilent);
            if (const auto *c = file_config.option<ConfigOptionStrings>("filament_colour"); c && !c->values.empty())
                e.gcode_result.extruder_colors = c->values;
        } catch (const std::exception &) { /* no settings in the file */ }
        return ORCA_OK;
    } catch (const std::bad_alloc &) {
        GCodeProcessor::s_IsBBLPrinter = bbl;
        return e.fail(ORCA_OOM, "Out of memory while reading the G-code");
    } catch (const std::exception &ex) {
        GCodeProcessor::s_IsBBLPrinter = bbl;
        return e.fail(ORCA_INVALID_INPUT, "Could not read the G-code", ex.what());
    }
}

const char *orca_export_preview(void *p)
{
    Engine &e = *as_engine(p);
    try {
        const GCodeProcessorResult &r = e.gcode_result;
        const std::vector<GCodeProcessorResult::MoveVertex> &moves = r.moves;
        // The vertices desktop's preview gets (LibVGCodeWrapper.cpp convert()): one per move after
        // the first, with a phantom in front of every path start; layers numbered consecutively.
        // Each vertex is a move index, the top bit set for a phantom.
        constexpr uint32_t PHANTOM = 0x80000000u;
        std::vector<uint32_t> verts;
        std::vector<uint32_t> layer_of;
        std::vector<double>   layer_times;
        verts.reserve(moves.empty() ? 0 : moves.size() + moves.size() / 4);
        layer_of.reserve(verts.capacity());
        uint32_t src_layer = UINT32_MAX, layer = 0;
        for (size_t i = 1; i < moves.size(); ++i) {
            const auto &curr = moves[i], &prev = moves[i - 1];
            if (curr.layer_id != src_layer) {
                if (src_layer != UINT32_MAX) ++layer;
                src_layer = curr.layer_id;
            }
            if (layer_times.size() <= layer) layer_times.resize(layer + 1, 0.0);
            layer_times[layer] += curr.time[0];
            if (starts_path(prev, curr, i == 1)) { verts.push_back(uint32_t(i) | PHANTOM); layer_of.push_back(layer); }
            verts.push_back(uint32_t(i));
            layer_of.push_back(layer);
        }
        const size_t n = verts.size();

        // Struct of arrays: positions (3 floats), one float array per value, the layers (uint32),
        // then one byte array each for role, move type, extruder and color.
        e.preview.reset();
        e.preview_bytes = n * 60;
        e.preview.reset(new char[std::max<size_t>(e.preview_bytes, 1)]);
        char *base = e.preview.get();
        float *pos = reinterpret_cast<float *>(base);
        float *val = pos + 3 * n;
        uint32_t *lay = reinterpret_cast<uint32_t *>(base + n * 52);
        uint8_t *bytes = reinterpret_cast<uint8_t *>(base + n * 56);
        for (size_t k = 0; k < n; ++k) {
            const uint32_t i = verts[k] & ~PHANTOM;
            const bool phantom = (verts[k] & PHANTOM) != 0;
            const auto &m = moves[i];
            const Vec3f &at = phantom ? moves[i - 1].position : m.position;
            pos[3 * k] = at.x(); pos[3 * k + 1] = at.y(); pos[3 * k + 2] = at.z();
            val[k] = m.height;
            val[n + k] = m.width;
            val[2 * n + k] = m.feedrate;
            val[3 * n + k] = phantom ? moves[i - 1].actual_feedrate : m.actual_feedrate;
            val[4 * n + k] = m.mm3_per_mm;
            val[5 * n + k] = m.fan_speed;
            val[6 * n + k] = m.temperature;
            val[7 * n + k] = m.pressure_advance;
            val[8 * n + k] = m.acceleration;
            val[9 * n + k] = m.jerk;
            lay[k] = layer_of[k];
            bytes[k] = preview_role(m.extrusion_role);
            bytes[n + k] = preview_type(m.type);
            bytes[2 * n + k] = uint8_t(m.extruder_id);
            bytes[3 * n + k] = uint8_t(m.cp_color_id);
        }

        // Filament colors (desktop's tool colors, and for "Filament" the colors after each color
        // change too: Plater::get_colors_for_color_print).
        // A slice leaves them to the caller (desktop takes them from its config).
        std::vector<std::string> tool_colors = r.extruder_colors;
        if (tool_colors.empty() && e.print) tool_colors = e.print->config().filament_colour.values;
        json colors = tool_colors, print_colors = tool_colors;
        for (const CustomGCode::Item &c : r.custom_gcode_per_print_z)
            if (c.type == CustomGCode::ColorChange) print_colors.push_back(c.color);
        // Filament used per filament, as desktop's Plater::load_gcode works out the cost.
        const PrintEstimatedStatistics &ps = r.print_statistics;
        json filaments = json::array();
        double total_m = 0, total_g = 0, total_cost = 0;
        for (const auto &[id, volume] : ps.total_volumes_per_extruder) {
            const double d = id < r.filament_diameters.size() ? r.filament_diameters[id] : 1.75;
            const double density = id < r.filament_densities.size() ? r.filament_densities[id] : 1.24;
            const double cost = id < r.filament_costs.size() ? r.filament_costs[id] : 0.0;
            const double m = volume / (M_PI * d * d / 4.0) / 1000.0, g = volume * density / 1000.0;
            filaments.push_back({{"id", id}, {"m", m}, {"g", g}});
            total_m += m; total_g += g; total_cost += g * cost / 1000.0;
        }
        json j = {
            {"data", uintptr_t(base)},
            {"bytes", e.preview_bytes},
            {"count", n},
            {"layer_times", layer_times},
            {"tool_colors", colors},
            {"print_colors", print_colors},
            {"filaments", filaments},
            {"time_s", ps.modes[0].time},
            {"filament_m", total_m},
            {"filament_g", total_g},
            {"cost", total_cost},
            {"spiral_vase", r.spiral_vase_mode},
        };
        return e.ret(j.dump());
    } catch (const std::bad_alloc &) {
        e.fail(ORCA_OOM, "Out of memory while exporting the preview");
    } catch (const std::exception &ex) {
        e.fail(ORCA_INTERNAL, "Could not export the preview", ex.what());
    }
    return nullptr;
}

int orca_set_layout(void *p, const char *json_text)
{
    Engine &e = *as_engine(p);
    if (e.running.load()) return e.fail(ORCA_INTERNAL, "A slice is running");
    try {
        const json j = json::parse(json_text ? json_text : "", nullptr, false);
        if (!j.is_object() || !j.contains("objects") || !j["objects"].is_array())
            return e.fail(ORCA_INVALID_INPUT, "Layout JSON must be {\"objects\":[…]}");
        // Validate everything before touching the model.
        std::vector<std::pair<size_t, std::vector<Transform3d>>> plan;
        // Painted supports per object (index in `plan`): one entry per model part, in desktop's
        // 3MF form (orca_paint_data); absent: as loaded.
        std::vector<std::pair<size_t, json>> paint;
        std::vector<bool> used(e.model.objects.size(), false);
        for (const json &o : j["objects"]) {
            if (!o.contains("index") || !o["index"].is_number_unsigned())
                return e.fail(ORCA_INVALID_INPUT, "Layout: object without index");
            const size_t idx = o["index"].get<size_t>();
            if (idx >= e.model.objects.size())
                return e.fail(ORCA_INVALID_INPUT, "Layout: bad object index");
            used[idx] = true;
            std::vector<Transform3d> mats;
            for (const json &i : o.value("instances", json::array())) {
                Transform3d m = Transform3d::Identity();
                if (!matrix_from_json(i.value("matrix", json()), m))
                    return e.fail(ORCA_INVALID_INPUT, "Layout: instance matrix must be 16 numbers");
                mats.push_back(m);
            }
            if (mats.empty()) return e.fail(ORCA_INVALID_INPUT, "Layout: object without instances");
            if (const json &sup = o.value("supports", json()); sup.is_array()) {
                size_t k = 0;
                for (const ModelVolume *mv : e.model.objects[idx]->volumes) {
                    if (!mv->is_model_part()) continue;
                    TriangleSelector::TriangleSplittingData data;
                    if (k < sup.size() && !orca_bridge::facets_from_json(data, sup[k], mv->mesh().its.indices.size()))
                        return e.fail(ORCA_INVALID_INPUT, "Layout: the painted supports don't fit the object");
                    ++k;
                }
                paint.emplace_back(plan.size(), sup);
            }
            plan.emplace_back(idx, std::move(mats));
        }
        // Reorder/delete objects, then set instances. An object listed again is a copy of it (one
        // painted differently than the others, say).
        std::vector<ModelObject *> keep;
        std::vector<bool> taken(e.model.objects.size(), false);
        const size_t loaded = e.model.objects.size();
        for (auto &[idx, mats] : plan) {
            ModelObject *o = e.model.objects[idx];
            if (taken[idx]) o = e.model.add_object(*o);
            taken[idx] = true;
            keep.push_back(o);
        }
        for (size_t i = loaded; i-- > 0;)
            if (!used[i]) e.model.delete_object(i);
        e.model.objects = keep;   // same pointers, new order (delete_object already freed the rest)
        for (size_t k = 0; k < plan.size(); ++k) {
            ModelObject *o = e.model.objects[k];
            const auto &mats = plan[k].second;
            while (o->instances.size() > mats.size()) o->delete_instance(o->instances.size() - 1);
            while (o->instances.size() < mats.size()) o->add_instance(*o->instances.front());
            for (size_t i = 0; i < mats.size(); ++i) o->instances[i]->set_transformation(Geometry::Transformation(mats[i]));
            o->invalidate_bounding_box();
        }
        for (auto &[k, sup] : paint) {
            size_t n = 0;
            for (ModelVolume *mv : e.model.objects[k]->volumes)
                if (mv->is_model_part()) { orca_bridge::set_volume_facets(mv->supported_facets, n < sup.size() ? sup[n] : json()); ++n; }
        }
        return ORCA_OK;
    } catch (const std::exception &ex) {
        return e.fail(ORCA_INVALID_INPUT, "Layout rejected", ex.what());
    }
}

// Desktop's Arrange (A, "Arrange all objects"): GUI/Jobs/ArrangeJob.cpp for one plate, with the
// arrange dialog's defaults (GLCanvas3D::ArrangeSettings: automatic spacing, no rotation, Y-axis
// alignment on i3 printers). Not here: plates other than the first (an object that does not fit
// goes to a virtual bed to the right, where desktop would make a new plate), the wipe tower
// (single extruder), IDEX/IQEX zones, belt regions and Bambu's calibration region.
const char *orca_arrange(void *p)
{
    Engine &e = *as_engine(p);
    if (e.running.load()) { e.fail(ORCA_INTERNAL, "A slice is running"); return nullptr; }
    if (!e.has_model) { e.fail(ORCA_INVALID_INPUT, "No model loaded"); return nullptr; }
    if (!e.has_config) { e.fail(ORCA_INVALID_CONFIG, "No config set"); return nullptr; }
    try {
        using namespace arrangement;
        DynamicPrintConfig cfg = e.print_config;
        cfg.apply(e.extra_config, true);

        // init_arrange_params: the print's skirt per object widens the clearance.
        float object_skirt_offset = 0;
        try {
            Print print;
            print.apply(e.model, cfg);
            object_skirt_offset = std::get<0>(print.object_skirt_offset());
        } catch (const std::exception &) { /* no skirt per object */ }
        ArrangeParams params;
        params.clearance_height_to_rod = cfg.opt_float("extruder_clearance_height_to_rod");
        params.clearance_height_to_lid = cfg.opt_float("extruder_clearance_height_to_lid");
        params.clearance_radius        = cfg.opt_float("extruder_clearance_radius") + object_skirt_offset * 2;
        params.object_skirt_offset     = object_skirt_offset;
        params.printable_height        = cfg.opt_float("printable_height");
        params.allow_rotations         = false;
        params.nozzle_height           = cfg.opt_float("nozzle_height");
        if (auto *o = cfg.opt<ConfigOptionPoint>("best_object_pos")) params.align_center = o->value;
        params.allow_multi_materials_on_same_plate = true;
        params.avoid_extrusion_cali_region         = true;
        auto *seq = cfg.option<ConfigOptionEnum<PrintSequence>>("print_sequence");
        params.is_seq_print     = seq && seq->value == PrintSequence::ByObject;
        params.min_obj_distance = 0;
        auto *structure = cfg.option<ConfigOptionEnum<PrinterStructure>>("printer_structure");
        params.align_to_y_axis = structure && structure->value == PrinterStructure::psI3;

        // prepare_all: every instance; desktop sets unprintable ones aside (none here).
        ArrangePolygons selected, unselected;
        std::vector<ModelInstance *> instances;
        for (ModelObject *mo : e.model.objects)
            for (ModelInstance *mi : mo->instances) {
                ArrangePolygon ap = get_instance_arrange_poly(mi, cfg);
                ap.itemid = int(selected.size());
                selected.emplace_back(std::move(ap));
                instances.push_back(mi);
            }

        // PartPlateList::preprocess_exclude_areas: wrapping detection, bed exclusion volumes and
        // the legacy excluded area (its bounding boxes, four corners each), on every bed.
        auto exclude_areas = [&cfg](ArrangePolygons &out, int beds, float inflation) {
            auto add = [&](Polygon poly, const std::string &name) {
                for (int j = 0; j < beds; ++j) {
                    ArrangePolygon r;
                    r.poly.contour = poly;
                    r.translation = Vec2crd(0, 0);
                    r.rotation = 0;
                    r.is_virt_object = true;
                    r.bed_idx = j;
                    r.height = 1;
                    r.name = name;
                    r.inflation = inflation;
                    out.emplace_back(std::move(r));
                }
            };
            auto *wrap = cfg.option<ConfigOptionBool>("enable_wrapping_detection");
            auto *wrap_area = cfg.option<ConfigOptionPoints>("wrapping_exclude_area");
            if (wrap && wrap->value && wrap_area && !wrap_area->values.empty()) {
                Polygon poly;
                for (const Vec2d &pt : wrap_area->values) poly.append({scale_(pt(0)), scale_(pt(1))});
                add(poly, "WrappingRegion");
            }
            if (has_bed_exclude_volumes(cfg)) {
                const BedExcludeVolumeMode mode = active_bed_exclude_volume_mode(cfg);
                const auto regions = get_bed_excluded_regions_by_extruder(cfg);
                const size_t n = mode == BedExcludeVolumeMode::Shared ? std::min<size_t>(1, regions.size()) : regions.size();
                for (size_t x = 0; x < n; ++x)
                    for (size_t k = 0; k < regions[x].size(); ++k) {
                        const BedExcludeRegion &region = regions[x][k];
                        if (!region.is_collision_volume() || region.polygon.points.size() < 3 ||
                            (region.has_z_range && region.z_max <= region.z_min + EPSILON))
                            continue;
                        for (int j = 0; j < beds; ++j) {
                            ArrangePolygon b;
                            b.poly.contour = bed_exclusion_arrange_polygon(region.polygon);
                            b.translation = Vec2crd::Zero();
                            b.rotation = 0;
                            b.is_virt_object = true;
                            b.is_bed_exclusion = true;
                            b.bed_exclusion_extruder_id = mode == BedExcludeVolumeMode::Shared ? -1 : int(x);
                            b.bed_idx = j;
                            b.height = std::max(0.0, region.z_max - region.z_min);
                            b.z_min = region.z_min;
                            b.z_max = region.z_max;
                            b.has_z_range = region.has_z_range;
                            b.name = "BedExclusionVolume" + std::to_string(x) + "_" + std::to_string(k);
                            b.inflation = inflation;
                            out.emplace_back(std::move(b));
                        }
                    }
            }
            if (auto *area = cfg.option<ConfigOptionPoints>("bed_exclude_area"))
                for (size_t i = 0; i + 3 < area->values.size(); i += 4) {
                    BoundingBoxf bb;
                    for (size_t k = i; k < i + 4; ++k) bb.merge(area->values[k]);
                    Polygon poly({{scaled(bb.min.x()), scaled(bb.min.y())}, {scaled(bb.max.x()), scaled(bb.min.y())},
                                  {scaled(bb.max.x()), scaled(bb.max.y())}, {scaled(bb.min.x()), scaled(bb.max.y())}});
                    add(poly, "ExcludedRegion" + std::to_string(i / 4));
                }
        };
        constexpr int MAX_PLATES = 36; // MAX_PLATE_COUNT
        exclude_areas(unselected, MAX_PLATES, 0);

        // process
        update_arrange_params(params, &cfg, selected);
        update_selected_items_inflation(selected, &cfg, params);
        update_unselected_items_inflation(unselected, &cfg, params);
        update_selected_items_axis_align(selected, &cfg, params);
        Points bedpts = get_shrink_bedpts(&cfg, params);
        exclude_areas(params.excluded_regions, 1, scale_(1));
        // The items stay in the order given; arrange() turns `itemid` into the arrange order.
        arrange(selected, unselected, bedpts, params);

        // finalize: nothing placed leaves everything as it was; an item on a further bed goes
        // where that plate would be (one row of plates to the right, desktop's plate stride).
        const bool nothing = std::none_of(selected.begin(), selected.end(), [](const ArrangePolygon &ap) { return ap.is_arranged(); });
        BoundingBoxf bed;
        for (const Vec2d &pt : cfg.opt<ConfigOptionPoints>("printable_area")->values) bed.merge(pt);
        const double stride = bed.size().x() * (1. + 1. / 5.); // LOGICAL_PART_PLATE_GAP
        json items = json::array();
        for (size_t i = 0; i < selected.size(); ++i) {
            const ArrangePolygon &ap = selected[i];
            ModelInstance *mi = instances[i];
            if (!nothing && ap.is_arranged()) {
                Vec2crd t = ap.translation;
                t.x() += scaled(stride * ap.bed_idx);
                mi->apply_arrange_result(t.cast<double>(), ap.rotation);
            }
            items.push_back({{"bed", ap.bed_idx}});
        }
        json objs = json::array();
        size_t k = 0;
        for (ModelObject *mo : e.model.objects) {
            mo->invalidate_bounding_box();
            json inst = json::array();
            for (ModelInstance *mi : mo->instances) inst.push_back({{"matrix", matrix_json(mi->get_matrix())}, {"bed", items[k++]["bed"]}});
            objs.push_back({{"instances", inst}});
        }
        return e.ret(json{{"objects", objs}}.dump());
    } catch (const std::bad_alloc &) {
        e.fail(ORCA_OOM, "Out of memory");
    } catch (const std::exception &ex) {
        e.fail(ORCA_INTERNAL, "Arrange failed", ex.what());
    }
    return nullptr;
}

int orca_set_config(void *p, const char *json_text)
{
    Engine &e = *as_engine(p);
    if (e.running.load()) return e.fail(ORCA_INTERNAL, "A slice is running");
    try {
        // load_from_json reads a file; MEMFS makes that cheap.
        const std::string tmp = "/tmp/orca_engine_config.json";
        {
            boost::nowide::ofstream f(tmp, std::ios::binary);
            f << (json_text ? json_text : "");
        }
        DynamicPrintConfig                 cfg;
        ConfigSubstitutionContext          subs(ForwardCompatibilitySubstitutionRule::Enable);
        std::map<std::string, std::string> key_values;
        std::string                        reason;
        if (cfg.load_from_json(tmp, subs, true, key_values, reason) != 0)
            return e.fail(ORCA_INVALID_CONFIG, "Config JSON rejected", reason);
        boost::filesystem::remove(tmp);
        // load_from_json() ends with handle_legacy_composite(), which re-formats "thumbnails"
        // ("a,b" -> "a, b"). The input is already the desktop app's in-memory config (it was
        // serialized from it), so keep the stored string exactly; it is echoed into the G-code.
        {
            const json j = json::parse(json_text ? json_text : "{}", nullptr, false);
            if (j.is_object() && j.contains("thumbnails") && j["thumbnails"].is_string() && cfg.has("thumbnails"))
                cfg.set_key_value("thumbnails", new ConfigOptionString(j["thumbnails"].get<std::string>()));
        }
        e.print_config = std::move(cfg);

        // CLI::run: m_extra_config defaults applied for every run.
        e.extra_config.clear();
        e.extra_config.set_key_value("has_filament_switcher", new ConfigOptionBool(false));
        e.extra_config.set_key_value("enable_filament_dynamic_map", new ConfigOptionBool(false));
        e.extra_config.normalize_fdm();
        e.has_config = true;
        return ORCA_OK;
    } catch (const std::exception &ex) {
        return e.fail(ORCA_INVALID_CONFIG, "Config JSON rejected", ex.what());
    }
}

int orca_set_calib(void *p, const char *json_text)
{
    Engine &e = *as_engine(p);
    if (e.running.load()) return e.fail(ORCA_INTERNAL, "A slice is running");
    const json j = json::parse(json_text ? json_text : "", nullptr, false);
    Calib_Params params;
    if (!j.is_null() && !(j.is_object() && orca_bridge::calib_params_from_json(j, params)))
        return e.fail(ORCA_INVALID_INPUT, "Bad calibration parameters");
    e.calib = params;
    return ORCA_OK;
}

int orca_slice_start(void *p, int plate, const char *out_path)
{
    Engine &e = *as_engine(p);
    if (e.running.load()) return e.fail(ORCA_INTERNAL, "A slice is already running");
    if (!e.has_model) return e.fail(ORCA_INVALID_INPUT, "No model loaded");
    if (!e.has_config) return e.fail(ORCA_INVALID_CONFIG, "No config set");
    e.plate    = plate < 1 ? 1 : plate;
    e.out_path = out_path ? out_path : "/out/plate.gcode";
    e.cancel_requested.store(false);
    {
        std::lock_guard<std::mutex> lock(e.mtx);
        e.progress_percent = 0;
        e.progress_message.clear();
        e.result_json = "{}";
    }
    boost::filesystem::create_directories(boost::filesystem::path(e.out_path).parent_path());
    try {
        e.print = std::make_unique<Print>();
    } catch (const std::bad_alloc &) {
        return e.fail(ORCA_OOM, "Out of memory");
    }
#ifdef __EMSCRIPTEN_PTHREADS__
    if (e.thread_joinable) { pthread_join(e.thread, nullptr); e.thread_joinable = false; }
    e.running.store(true);
    e.status.store(ORCA_RUNNING);
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 16 * 1024 * 1024);  // libslic3r recurses deeply (Clipper, Voronoi)
    const int rc = pthread_create(&e.thread, &attr, slice_thread, &e);
    pthread_attr_destroy(&attr);
    if (rc != 0) {
        e.running.store(false);
        e.status.store(e.fail(ORCA_INTERNAL, "Could not start the slicing thread"));
        return e.status.load();
    }
    e.thread_joinable = true;
    return ORCA_RUNNING;
#else
    e.status.store(do_slice(e));
    return e.status.load();
#endif
}

int orca_slice_poll(void *p)
{
    Engine &e = *as_engine(p);
#ifdef __EMSCRIPTEN_PTHREADS__
    if (e.running.load()) return ORCA_RUNNING;
    if (e.thread_joinable) { pthread_join(e.thread, nullptr); e.thread_joinable = false; }
#endif
    return e.status.load();
}

void orca_cancel(void *p)
{
    Engine &e = *as_engine(p);
    e.cancel_requested.store(true);
    if (e.print) e.print->cancel();
}

const char *orca_progress(void *p)
{
    Engine &e = *as_engine(p);
    std::lock_guard<std::mutex> lock(e.mtx);
    return e.ret(json{{"percent", e.progress_percent}, {"message", e.progress_message}}.dump());
}

const char *orca_result(void *p)
{
    Engine &e = *as_engine(p);
    std::lock_guard<std::mutex> lock(e.mtx);
    return e.ret(e.result_json);
}

const char *orca_last_error(void *p)
{
    Engine &e = *as_engine(p);
    std::lock_guard<std::mutex> lock(e.mtx);
    return e.ret(e.error_json);
}

const char *orca_config_schema(void)
{
    // Every option of OrcaSlicer's PrintConfigDef (what the desktop settings tabs are built
    // from), plus which keys each preset type owns. Built once.
    static const std::string schema = [] {
        auto type_name = [](ConfigOptionType t) -> const char * {
            switch (t) {
            case coFloat: return "float"; case coFloats: return "floats";
            case coInt: return "int"; case coInts: return "ints";
            case coString: return "string"; case coStrings: return "strings";
            case coPercent: return "percent"; case coPercents: return "percents";
            case coFloatOrPercent: return "float_or_percent"; case coFloatsOrPercents: return "floats_or_percents";
            case coPoint: return "point"; case coPoints: return "points"; case coPoint3: return "point3";
            case coBool: return "bool"; case coBools: return "bools";
            case coEnum: return "enum"; case coEnums: return "enums";
            case coIntsGroups: return "ints_groups"; case coPointsGroups: return "points_groups";
            default: return "none";
            }
        };
        auto gui_name = [](ConfigOptionDef::GUIType g) -> const char * {
            using G = ConfigOptionDef::GUIType;
            switch (g) {
            case G::i_enum_open: return "i_enum_open"; case G::f_enum_open: return "f_enum_open";
            case G::color: return "color"; case G::select_open: return "select_open";
            case G::slider: return "slider"; case G::legend: return "legend";
            case G::one_string: return "one_string";
            default: return "";
            }
        };
        static const char *modes[] = {"simple", "advanced", "expert", "develop"};
        json opts = json::object();
        for (const auto &[key, def] : print_config_def.options) {
            json o = {
                {"type", type_name(def.type)},
                {"label", def.label},
                {"full_label", def.full_label},
                {"category", def.category},
                {"tooltip", def.tooltip},
                {"sidetext", def.sidetext},
                {"mode", modes[std::min<int>(int(def.mode), 3)]},
            };
            if (def.nullable) o["nullable"] = true;
            if (def.default_value) o["default"] = def.default_value->serialize();
            if (!def.enum_values.empty()) o["enum_values"] = def.enum_values;
            if (!def.enum_labels.empty()) o["enum_labels"] = def.enum_labels;
            if (def.min > -FLT_MAX) o["min"] = def.min;
            if (def.max < FLT_MAX) o["max"] = def.max;
            if (const char *g = gui_name(def.gui_type); *g) o["gui_type"] = g;
            if (def.multiline) o["multiline"] = true;
            if (def.full_width) o["full_width"] = true;
            if (def.is_code) o["is_code"] = true;
            if (def.readonly) o["readonly"] = true;
            if (def.height > 0) o["height"] = def.height;
            if (!def.ratio_over.empty()) o["ratio_over"] = def.ratio_over;
            if (def.printer_technology != ptUnknown) o["technology"] = def.printer_technology == ptFFF ? "fff" : "sla";
            opts[key] = std::move(o);
        }
        return json{
            {"orca_version", SoftFever_VERSION},
            {"options", std::move(opts)},
            {"print", Preset::print_options()},
            {"filament", Preset::filament_options()},
            {"printer", Preset::printer_options()},
        }.dump();
    }();
    return schema.c_str();
}

} // extern "C"
