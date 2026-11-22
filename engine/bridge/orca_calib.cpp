// Desktop's calibration tests (its Calibration menu): Plater::calib_* and their helpers
// (GUI/Plater.cpp, Utils/CalibUtils.cpp). As on desktop each one changes the edited print,
// filament and printer presets and makes a new plate of its test model; here that plate is saved
// as a 3MF (the objects with their own settings) for the app to put on its plate, and the
// parameters G-code export takes (Print::set_calib_params) are returned for its slices.
// SPDX-License-Identifier: AGPL-3.0-or-later

#include "orca_engine.h"
#include "engine_internal.hpp"

#include <libslic3r/libslic3r.h>
#include <libslic3r/Arrange.hpp>
#include <libslic3r/CutUtils.hpp>
#include <libslic3r/Flow.hpp>
#include <libslic3r/Format/bbs_3mf.hpp>
#include <libslic3r/Geometry.hpp>
#include <libslic3r/Model.hpp>
#include <libslic3r/ParameterUtils.hpp>
#include <libslic3r/PresetBundle.hpp>
#include <libslic3r/PrintConfig.hpp>
#include <libslic3r/TriangleMesh.hpp>
#include <libslic3r/calib.hpp>

#include <boost/filesystem.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
#include <string>
#include <vector>

using namespace Slic3r;
using json = nlohmann::json;

namespace {

const std::pair<CalibMode, const char *> MODES[] = {
    {CalibMode::Calib_None, "none"},
    {CalibMode::Calib_PA_Line, "pa_line"},
    {CalibMode::Calib_PA_Pattern, "pa_pattern"},
    {CalibMode::Calib_PA_Tower, "pa_tower"},
    {CalibMode::Calib_Flow_Rate, "flow_rate"},
    {CalibMode::Calib_Temp_Tower, "temp_tower"},
    {CalibMode::Calib_Vol_speed_Tower, "vol_speed_tower"},
    {CalibMode::Calib_VFA_Tower, "vfa_tower"},
    {CalibMode::Calib_Retraction_tower, "retraction_tower"},
    {CalibMode::Calib_Input_shaping_freq, "input_shaping_freq"},
    {CalibMode::Calib_Input_shaping_damp, "input_shaping_damp"},
    {CalibMode::Calib_Cornering, "cornering"},
};

template<typename T, typename OptionType> void set_config_values(DynamicPrintConfig *config, const std::string &key, T value)
{
    if (auto *opt = config->option<OptionType>(key))
        for (size_t i = 0; i < opt->values.size(); ++i) opt->values[i] = value;
}

// A calibration print sets pressure advance explicitly to 0 on each extruder variant that has it
// disabled, so the value stored in the printer does not skew the result.
void zero_pressure_advance_where_disabled(DynamicPrintConfig *filament_config)
{
    auto enable_pa   = filament_config->option<ConfigOptionBools>("enable_pressure_advance");
    auto pa          = filament_config->option<ConfigOptionFloats>("pressure_advance");
    auto adaptive_pa = filament_config->option<ConfigOptionBools>("adaptive_pressure_advance");
    if (!enable_pa || !pa || !adaptive_pa || pa->empty() || adaptive_pa->empty())
        return;
    if (pa->size() < enable_pa->size()) pa->resize(enable_pa->size());
    if (adaptive_pa->size() < enable_pa->size()) adaptive_pa->resize(enable_pa->size());
    for (size_t variant = 0; variant < enable_pa->size(); ++variant) {
        if (enable_pa->get_at(variant)) continue;
        enable_pa->values[variant]   = true;
        pa->values[variant]          = 0.0;
        adaptive_pa->values[variant] = false;
    }
}

// Marlin firmware with machine_max_junction_deviation > 0.
bool has_junction_deviation(const DynamicPrintConfig *printer_config)
{
    const auto gcode_flavor = printer_config->option<ConfigOptionEnum<GCodeFlavor>>("gcode_flavor");
    const auto junction_dev = printer_config->option<ConfigOptionFloats>("machine_max_junction_deviation");
    return gcode_flavor && gcode_flavor->value == GCodeFlavor::gcfMarlinFirmware && junction_dev && !junction_dev->values.empty() &&
           junction_dev->values.front() > 0.0;
}

json params_json(const Calib_Params &p)
{
    std::string mode = "none";
    for (const auto &[m, n] : MODES)
        if (m == p.mode) mode = n;
    return {{"mode", mode},
            {"extruder_id", p.extruder_id},
            {"start", p.start},
            {"end", p.end},
            {"step", p.step},
            {"print_numbers", p.print_numbers},
            {"freqStartX", p.freqStartX},
            {"freqEndX", p.freqEndX},
            {"freqStartY", p.freqStartY},
            {"freqEndY", p.freqEndY},
            {"test_model", p.test_model},
            {"shaper_type", p.shaper_type},
            {"accelerations", p.accelerations},
            {"speeds", p.speeds},
            {"vfa_layer_height", p.vfa_layer_height},
            {"nozzle_based_resize", p.nozzle_based_resize}};
}

struct Calib
{
    PresetBundle      &b;
    std::string        assets;
    Model              model;
    json               notices = json::array();

    DynamicPrintConfig &print() { return b.prints.get_edited_preset().config; }
    DynamicPrintConfig &filament() { return b.filaments.get_edited_preset().config; }
    DynamicPrintConfig &printer() { return b.printers.get_edited_preset().config; }

    // BuildVolume::bed_center
    Vec2d bed_center() { return get_extents(printer().option<ConfigOptionPoints>("printable_area")->values).center(); }

    // Plater::add_model → load_files → load_model_objects: an object without a placement is
    // centered around its origin and put in the middle of the bed; all rest on the bed. The
    // objects of a 3MF keep their layout, in the middle of the bed (their own positions are for
    // another bed).
    bool add_model(const std::string &rel)
    {
        const std::string path = assets + "/" + rel;
        if (!boost::filesystem::exists(path)) return false;
        Model loaded = Model::read_from_file(path, nullptr, nullptr, LoadStrategy::LoadModel);
        if (loaded.objects.empty()) return false;
        const Vec2d center = bed_center();
        BoundingBoxf3 placed;
        for (ModelObject *mo : loaded.objects)
            if (!mo->instances.empty()) placed.merge(mo->instance_bounding_box(0));
        if (placed.defined)
            for (ModelObject *mo : loaded.objects)
                for (ModelInstance *inst : mo->instances)
                    inst->set_offset(inst->get_offset() + to_3d(Vec2d(center - to_2d(placed.center())), 0.));
        for (ModelObject *mo : loaded.objects) {
            ModelObject *object = model.add_object(*mo);
            object->sort_volumes(true);
            if (object->input_file.empty()) object->input_file = path;
            if (object->name.empty()) object->name = boost::filesystem::path(path).filename().string();
            if (object->instances.empty()) {
                object->center_around_origin();
                ModelInstance *instance = object->add_instance();
                instance->set_offset(to_3d(center, -object->origin_translation(2)));
            }
            object->ensure_on_bed();
        }
        return true;
    }

    // Plater::cut_horizontal and apply_cut_object_to_model: the object is replaced by the parts
    // kept, at the end of the list.
    void cut_horizontal(size_t obj_idx, size_t instance_idx, double z, ModelObjectCutAttributes attributes)
    {
        if (obj_idx >= model.objects.size()) return;
        ModelObject *object = model.objects[obj_idx];
        if (instance_idx >= object->instances.size()) return;
        if (!attributes.has(ModelObjectCutAttribute::KeepUpper) && !attributes.has(ModelObjectCutAttribute::KeepLower)) return;
        const Vec3d instance_offset = object->instances[instance_idx]->get_offset();
        Cut         cut(object, int(instance_idx), Geometry::translation_transform(z * Vec3d::UnitZ() - instance_offset), attributes);
        const ModelObjectPtrs new_objects = cut.perform_with_plane();
        std::vector<ModelObject *> added;
        for (ModelObject *o : new_objects) added.push_back(model.add_object(*o));
        model.delete_object(obj_idx);
        for (ModelObject *o : added) {
            o->sort_volumes(true);
            o->ensure_on_bed();
        }
    }

    // The belt printer's slicing rotation, which calibration objects are turned back by.
    bool belt_rotation(double &angle_rad, Vec3d &axis)
    {
        const auto *belt_opt = printer().option<ConfigOptionBool>("belt_printer");
        if (belt_opt == nullptr || !belt_opt->value) return false;
        const auto *axis_opt  = printer().option<ConfigOptionEnum<BeltRotationAxis>>("belt_slice_rotation");
        const auto *angle_opt = printer().option<ConfigOptionFloat>("belt_slice_rotation_angle");
        if (axis_opt == nullptr || angle_opt == nullptr) return false;
        switch (axis_opt->value) {
        case BeltRotationAxis::X: axis = Vec3d::UnitX(); break;
        case BeltRotationAxis::Y: axis = Vec3d::UnitY(); break;
        default: return false;
        }
        angle_rad = -Geometry::deg2rad(angle_opt->value);
        return std::abs(angle_rad) > EPSILON;
    }

    bool belt_printer()
    {
        const auto *opt = printer().option<ConfigOptionBool>("belt_printer");
        return opt != nullptr && opt->value;
    }

    // Plater's belt_calib_flip_ringing_tower: its sloped face then leans over the belt.
    void flip_ringing_tower()
    {
        double angle_rad = 0.;
        Vec3d  axis      = Vec3d::UnitX();
        if (belt_rotation(angle_rad, axis) && !model.objects.empty()) model.objects.front()->rotate(M_PI, Vec3d::UnitZ());
    }

    // Plater::_calib_apply_belt_mode: each object stands upright in slicing space, on a support
    // wedge, the rows of a test spaced for the wedges.
    void apply_belt_mode()
    {
        double angle_rad = 0.;
        Vec3d  axis      = Vec3d::UnitX();
        if (!belt_rotation(angle_rad, axis)) return;
        print().set_key_value("skirt_loops", new ConfigOptionInt(0));
        const Matrix3d cancel_rotation = Eigen::AngleAxisd(angle_rad, axis).toRotationMatrix();
        std::vector<ModelObject *> objs;
        for (ModelObject *obj : model.objects) {
            if (obj->instances.size() != 1) continue;
            objs.push_back(obj);
            obj->config.set_key_value("enable_support", new ConfigOptionBool(true));
            obj->config.set_key_value("support_type", new ConfigOptionEnum<SupportType>(stTree));
            obj->config.set_key_value("support_style", new ConfigOptionEnum<SupportMaterialStyle>(smsTreeHybrid));
            obj->config.set_key_value("support_on_build_plate_only", new ConfigOptionBool(false));
            obj->config.set_key_value("support_base_pattern", new ConfigOptionEnum<SupportMaterialPattern>(smpRectilinear));
            ModelInstance *inst = obj->instances.front();
            inst->rotate(cancel_rotation);
            obj->invalidate_bounding_box();
            obj->ensure_on_bed();
        }
        if (objs.size() > 1) {
            std::vector<ModelObject *> sorted = objs;
            std::sort(sorted.begin(), sorted.end(), [](const ModelObject *a, const ModelObject *b) {
                return a->instances.front()->get_offset(Y) < b->instances.front()->get_offset(Y);
            });
            std::vector<std::vector<ModelObject *>> rows;
            double row_y = std::numeric_limits<double>::quiet_NaN();
            for (ModelObject *o : sorted) {
                const double oy = o->instances.front()->get_offset(Y);
                if (rows.empty() || oy - row_y > 1.) rows.emplace_back();
                rows.back().emplace_back(o);
                row_y = oy;
            }
            const double wedge_factor = std::abs(std::tan(angle_rad));
            double       cursor       = std::numeric_limits<double>::quiet_NaN();
            for (std::vector<ModelObject *> &row : rows) {
                double rmin = std::numeric_limits<double>::max(), rmax = std::numeric_limits<double>::lowest();
                for (ModelObject *o : row) {
                    const BoundingBoxf3 bb = o->instance_bounding_box(0);
                    rmin = std::min(rmin, bb.min.y());
                    rmax = std::max(rmax, bb.max.y());
                }
                if (std::isnan(cursor)) cursor = rmin;
                const double shift = cursor - rmin;
                for (ModelObject *o : row) {
                    ModelInstance *inst = o->instances.front();
                    inst->set_offset(Y, inst->get_offset(Y) + shift);
                    o->invalidate_bounding_box();
                }
                cursor += (rmax - rmin) * (1. + wedge_factor) + 5.;
            }
        }
    }

    std::vector<int> extruder_types()
    {
        const auto *o = printer().option<ConfigOptionEnumsGeneric>("extruder_type");
        return o ? o->values : std::vector<int>{};
    }
    std::vector<int> nozzle_volume_types()
    {
        const auto *o = b.project_config.option<ConfigOptionEnumsGeneric>("nozzle_volume_type");
        return o && !o->values.empty() ? o->values : std::vector<int>{int(nvtStandard)};
    }
    static int at(const std::vector<int> &v, size_t i, int def) { return i < v.size() ? v[i] : (v.empty() ? def : v.back()); }

    // CalibUtils' update_speed_parameter: the speed the filament's max volumetric speed allows.
    void update_speed_parameter(const std::string &key)
    {
        auto &printer_config = printer(), &filament_config = filament(), &print_config = print();
        const int  extruder_nums = b.get_printer_extruder_count();
        const auto types = extruder_types(), volumes = nozzle_volume_types();
        const float nozzle_diameter = printer_config.option<ConfigOptionFloats>("nozzle_diameter")->values[0];
        const float layer_height    = print_config.option<ConfigOptionFloat>("layer_height")->value;
        float line_width = print_config.get_abs_value("line_width", nozzle_diameter);
        if (line_width <= 0.) line_width = Flow::auto_extrusion_width(frPerimeter, nozzle_diameter);
        const Flow flow(line_width, layer_height, nozzle_diameter);
        for (int i = 0; i < extruder_nums; ++i) {
            const ExtruderType     et = ExtruderType(at(types, i, int(etDirectDrive)));
            const NozzleVolumeType nv = NozzleVolumeType(at(volumes, i, int(nvtStandard)));
            int index = get_index_for_extruder_parameter(filament_config, "filament_max_volumetric_speed", i, et, nv);
            const double max_speed = filament_config.option<ConfigOptionFloats>("filament_max_volumetric_speed")->get_at(index) / flow.mm3_per_mm();
            index = get_index_for_extruder_parameter(print_config, key, i, et, nv);
            if (auto *speed_opt = print_config.option<ConfigOptionFloatsNullable>(key); speed_opt && index < int(speed_opt->values.size()))
                speed_opt->values[index] = max_speed;
        }
    }

    // CalibUtils' generate_max_speed_parameter_value.
    std::vector<double> max_speed_values(const std::string &key, float line_width, float layer_height, bool linear, int pass)
    {
        auto &printer_config = printer(), &filament_config = filament(), &print_config = print();
        const int  extruder_nums = b.get_printer_extruder_count();
        const auto types = extruder_types(), volumes = nozzle_volume_types();
        const float nozzle_diameter = printer_config.option<ConfigOptionFloats>("nozzle_diameter")->values[0];
        const Flow  flow(line_width, layer_height, nozzle_diameter);
        std::vector<double> speed_values;
        for (int i = 0; i < extruder_nums; ++i) {
            const ExtruderType     et = ExtruderType(at(types, i, int(etDirectDrive)));
            const NozzleVolumeType nv = NozzleVolumeType(at(volumes, i, int(nvtStandard)));
            int index = get_index_for_extruder_parameter(filament_config, "filament_max_volumetric_speed", i, et, nv);
            const double max_vol      = filament_config.option<ConfigOptionFloats>("filament_max_volumetric_speed")->get_at(index);
            const double cur_flowrate = filament_config.option<ConfigOptionFloats>("filament_flow_ratio")->get_at(index);
            const double max_speed    = linear ? max_vol / (flow.mm3_per_mm() * (cur_flowrate + (pass == 2 ? 0.035 : 0.05)) / cur_flowrate) :
                                                 max_vol / (flow.mm3_per_mm() * (pass == 1 ? 1.2 : 1));
            index = get_index_for_extruder_parameter(print_config, key, i, et, nv);
            const auto *speed_opt = print_config.option<ConfigOptionFloatsNullable>(key);
            const double speed_value = std::floor(std::min(speed_opt->get_at(index), max_speed));
            for (size_t v = 0; v < volumes.size(); ++v) speed_values.emplace_back(speed_value);
        }
        return speed_values;
    }

    // ── The tests ─────────────────────────────────────────────────────────────────────────

    // Plater::calib_pa
    bool pa(Calib_Params &params)
    {
        print().set_key_value("overhang_reverse", new ConfigOptionBool(false));
        print().set_key_value("precise_z_height", new ConfigOptionBool(false));
        print().set_key_value("wipe_inward", new ConfigOptionBool(false));
        printer().set_key_value("resonance_avoidance", new ConfigOptionBool{false});
        switch (params.mode) {
        case CalibMode::Calib_PA_Line: return add_model("pressure_advance/pressure_advance_test.drc");
        case CalibMode::Calib_PA_Pattern: return pa_pattern(params);
        case CalibMode::Calib_PA_Tower: return pa_tower(params);
        default: return false;
        }
    }

    // Plater::_calib_pa_pattern
    bool pa_pattern(Calib_Params &params)
    {
        std::vector<double> speeds{params.speeds};
        std::vector<double> accels{params.accelerations};
        auto *printer_config  = &printer();
        DynamicPrintConfig &print_config = print();
        auto *filament_config = &filament();
        const double nozzle_diameter = printer_config->option<ConfigOptionFloats>("nozzle_diameter")->get_at(0);
        set_config_values<bool, ConfigOptionBoolsNullable>(filament_config, "filament_retract_when_changing_layer", false);
        set_config_values<bool, ConfigOptionBoolsNullable>(filament_config, "filament_wipe", false);
        set_config_values<bool, ConfigOptionBools>(printer_config, "wipe", false);
        set_config_values<bool, ConfigOptionBools>(printer_config, "retract_when_changing_layer", false);
        printer_config->set_key_value("resonance_avoidance", new ConfigOptionBool(false));

        auto accel = print_config.get_abs_value_at("outer_wall_acceleration", params.extruder_id);
        if (accel == 0) accel = print_config.get_abs_value_at("inner_wall_acceleration", params.extruder_id);
        if (accel == 0) accel = print_config.get_abs_value_at("default_acceleration", params.extruder_id);
        if (accels.empty()) {
            accels.assign({accel});
            notices.push_back({{"kind", "accel"}, {"value", long(accel)}});
        } else {
            accel = *std::max_element(accels.begin(), accels.end());
        }
        set_config_values<double, ConfigOptionFloatsNullable>(&print_config, "outer_wall_acceleration", accel);
        print_config.set_key_value("print_sequence", new ConfigOptionEnum(PrintSequence::ByLayer));

        if (!has_junction_deviation(printer_config) && print_config.get_abs_value_at("default_jerk", params.extruder_id) > 0) {
            auto jerk = print_config.get_abs_value_at("outer_wall_jerk", params.extruder_id);
            if (jerk == 0) jerk = print_config.get_abs_value_at("inner_wall_jerk", params.extruder_id);
            if (jerk == 0) jerk = print_config.get_abs_value_at("default_jerk", params.extruder_id);
            for (const char *k : {"default_jerk", "outer_wall_jerk", "inner_wall_jerk", "top_surface_jerk", "infill_jerk", "travel_jerk"})
                set_config_values<double, ConfigOptionFloatsNullable>(&print_config, k, jerk);
        }
        if (has_junction_deviation(printer_config))
            set_config_values<double, ConfigOptionFloatsNullable>(&print_config, "default_junction_deviation", 0);

        const SuggestedConfigCalibPAPattern suggested;
        for (const auto &opt : suggested.floats_pairs)
            set_config_values<double, ConfigOptionFloatsNullable>(&print_config, opt.first, opt.second[0]);
        for (const auto &opt : suggested.nozzle_ratio_pairs)
            print_config.set_key_value(opt.first, new ConfigOptionFloatOrPercent(nozzle_diameter * opt.second / 100, false));
        for (const auto &opt : suggested.int_pairs) print_config.set_key_value(opt.first, new ConfigOptionInt(opt.second));
        print_config.set_key_value(suggested.brim_pair.first, new ConfigOptionEnum<BrimType>(suggested.brim_pair.second));
        print_config.set_key_value("enable_wrapping_detection", new ConfigOptionBool(false));

        if (speeds.empty()) {
            const double speed = CalibPressureAdvance::find_optimal_PA_speed(b.full_config(), print_config.get_abs_value("line_width", nozzle_diameter),
                                                                             print_config.get_abs_value("layer_height"), 0, 0);
            set_config_values<double, ConfigOptionFloatsNullable>(&print_config, "outer_wall_speed", speed);
            speeds.assign({speed});
            notices.push_back({{"kind", "speed"}, {"value", long(speed)}});
        } else if (speeds.size() == 1) {
            set_config_values<double, ConfigOptionFloatsNullable>(&print_config, "outer_wall_speed", speeds.front());
        }

        const DynamicPrintConfig full_config = b.full_config();
        const bool is_bbl_machine = b.is_bbl_vendor();
        const Vec3d origin = Vec3d::Zero();

        // The "handle" cube (desktop's generic Cube: its size is set below).
        ModelObject *cube = model.add_object();
        cube->name = "Cube";
        cube->add_volume(TriangleMesh(its_make_cube(10, 10, 10)));
        cube->add_instance();
        cube->center_around_origin();
        cube->ensure_on_bed();

        CalibPressureAdvancePattern pa_pattern(params, full_config, is_bbl_machine, *cube, origin);

        // Scaled to the test pattern's size to arrange the patterns, then to the handle's.
        auto cube_bb = cube->raw_bounding_box();
        cube->scale((pa_pattern.print_size_x() + 4) / cube_bb.size().x(), (pa_pattern.print_size_y() + 4) / cube_bb.size().y(),
                    pa_pattern.max_layer_z() / cube_bb.size().z());
        arrangement::ArrangePolygons arranged_items;
        {
            arrangement::ArrangeParams ap;
            Points bedpts = arrangement::get_shrink_bedpts(&full_config, ap);
            for (size_t i = 0; i < speeds.size() * accels.size(); i++) {
                arrangement::ArrangePolygon p;
                cube->instances[0]->get_arrange_polygon(&p);
                p.bed_idx = 0;
                arranged_items.emplace_back(p);
            }
            arrangement::arrange(arranged_items, bedpts, ap);
        }
        cube_bb = cube->raw_bounding_box();
        cube->scale(pa_pattern.handle_xy_size() / cube_bb.size().x(), pa_pattern.handle_xy_size() / cube_bb.size().y(),
                    pa_pattern.max_layer_z() / cube_bb.size().z());

        // Speed and acceleration per object; the patterns' G-code is made when slicing.
        // (Desktop puts patterns that don't fit on more plates; the app has one.)
        for (size_t test_idx = 0; test_idx < arranged_items.size(); test_idx++) {
            const auto &ai   = arranged_items[test_idx];
            const auto  tspd = speeds[test_idx % speeds.size()];
            const auto  tacc = accels[test_idx / speeds.size()];
            ModelObject *obj = test_idx == 0 ? cube : model.add_object(*cube);
            obj->name.assign(std::string("pa_pattern_") + std::to_string(int(tspd)) + std::string("_") + std::to_string(int(tacc)));
            if (speeds.size() > 1) obj->config.set_key_value("outer_wall_speed", new ConfigOptionFloatsNullable(1, tspd));
            if (accels.size() > 1) obj->config.set_key_value("outer_wall_acceleration", new ConfigOptionFloatsNullable(1, tacc));
            const Vec3d obj_offset{unscale<double>(ai.translation(X)), unscale<double>(ai.translation(Y)), 0};
            obj->instances[0]->set_offset(origin + obj_offset + pa_pattern.handle_pos_offset());
            obj->ensure_on_bed();
        }
        return true;
    }

    // Plater::_calib_pa_tower
    bool pa_tower(const Calib_Params &params)
    {
        if (!add_model("pressure_advance/tower_with_seam.drc")) return false;
        auto &print_config = print();
        print_config.set_key_value("enable_wrapping_detection", new ConfigOptionBool(false));
        filament().set_key_value("slow_down_layer_time", new ConfigOptionFloats{1.0f});
        auto &obj_cfg = model.objects[0]->config;
        obj_cfg.set_key_value("alternate_extra_wall", new ConfigOptionBool(false));
        update_speed_parameter("outer_wall_speed");
        update_speed_parameter("inner_wall_speed");
        obj_cfg.set_key_value("seam_position", new ConfigOptionEnum<SeamPosition>(spRear));
        obj_cfg.set_key_value("wall_loops", new ConfigOptionInt(2));
        obj_cfg.set_key_value("top_shell_layers", new ConfigOptionInt(0));
        obj_cfg.set_key_value("bottom_shell_layers", new ConfigOptionInt(0));
        obj_cfg.set_key_value("sparse_infill_density", new ConfigOptionPercent(0));
        obj_cfg.set_key_value("brim_type", new ConfigOptionEnum<BrimType>(btEar));
        obj_cfg.set_key_value("brim_object_gap", new ConfigOptionFloat(.0f));
        obj_cfg.set_key_value("brim_ears_max_angle", new ConfigOptionFloat(135.f));
        obj_cfg.set_key_value("brim_width", new ConfigOptionFloat(6.f));
        obj_cfg.set_key_value("seam_slope_type", new ConfigOptionEnum<SeamScarfType>(SeamScarfType::None));
        print_config.set_key_value("max_volumetric_extrusion_rate_slope", new ConfigOptionFloat(0));

        const auto new_height = std::ceil((params.end - params.start) / params.step) + 1;
        const auto obj_bb = model.objects[0]->bounding_box_exact();
        if (new_height < obj_bb.size().z()) cut_horizontal(0, 0, new_height, ModelObjectCutAttribute::KeepLower);
        apply_belt_mode();
        return true;
    }

    // Plater::calib_flowrate and adjust_settings_for_flowrate_calib
    bool flowrate(bool linear, int pass, InfillPattern pattern)
    {
        if (pass != 1 && pass != 2) return false;
        const char *file = linear ? (pass == 1 ? "filament_flow/Orca-LinearFlow.3mf" : "filament_flow/Orca-LinearFlow_fine.3mf") :
                                    (pass == 1 ? "filament_flow/flowrate-test-pass1.3mf" : "filament_flow/flowrate-test-pass2.3mf");
        if (!add_model(file)) return false;

        auto *print_config = &print(), *filament_config = &filament();
        const float nozzle_diameter = printer().option<ConfigOptionFloats>("nozzle_diameter")->values[0];
        const float xyScale         = nozzle_diameter / 0.6;
        double first_layer_height = print_config->option<ConfigOptionFloat>("initial_layer_print_height")->value;
        const double layer_height = nozzle_diameter / 2.0;
        first_layer_height        = std::max(first_layer_height, layer_height);

        // Selection::scale of all the objects: about the middle of them all, then on the bed.
        const float zscale = (first_layer_height + 9 * layer_height) / 2;
        const Vec3d factor = xyScale > 1.2 ? Vec3d(xyScale, xyScale, zscale) : Vec3d(1, 1, zscale);
        BoundingBoxf3 all;
        for (ModelObject *o : model.objects) all.merge(o->instance_bounding_box(0));
        const Vec3d center = all.center();
        for (ModelObject *o : model.objects) {
            for (ModelInstance *inst : o->instances) {
                const Vec3d offset = inst->get_offset();
                inst->set_offset(center + (offset - center).cwiseProduct(factor));
                inst->set_scaling_factor(inst->get_scaling_factor().cwiseProduct(factor));
            }
            o->invalidate_bounding_box();
            o->ensure_on_bed();
        }

        const double cur_flowrate      = filament_config->option<ConfigOptionFloats>("filament_flow_ratio")->get_at(0);
        const float  infill_line_width = nozzle_diameter * 1.2f;
        const std::vector<double> internal_solid_speeds = max_speed_values("internal_solid_infill_speed", infill_line_width, layer_height, linear, pass);
        const std::vector<double> top_surface_speeds = max_speed_values("top_surface_speed", infill_line_width, layer_height, linear, pass);

        for (ModelObject *_obj : model.objects) {
            auto &c = _obj->config;
            _obj->ensure_on_bed();
            c.set_key_value("wall_loops", new ConfigOptionInt(1));
            c.set_key_value("only_one_wall_top", new ConfigOptionBool(true));
            c.set_key_value("thick_internal_bridges", new ConfigOptionBool(false));
            c.set_key_value("enable_extra_bridge_layer", new ConfigOptionEnum<EnableExtraBridgeLayer>(eblDisabled));
            c.set_key_value("internal_bridge_density", new ConfigOptionPercent(100));
            c.set_key_value("sparse_infill_density", new ConfigOptionPercent(35));
            c.set_key_value("min_width_top_surface", new ConfigOptionFloatOrPercent(100, true));
            c.set_key_value("bottom_shell_layers", new ConfigOptionInt(2));
            c.set_key_value("top_shell_layers", new ConfigOptionInt(5));
            c.set_key_value("top_shell_thickness", new ConfigOptionFloat(0));
            c.set_key_value("bottom_shell_thickness", new ConfigOptionFloat(0));
            c.set_key_value("detect_thin_wall", new ConfigOptionBool(true));
            c.set_key_value("filter_out_gap_fill", new ConfigOptionFloat(0));
            c.set_key_value("sparse_infill_pattern", new ConfigOptionEnum<InfillPattern>(ipRectilinear));
            c.set_key_value("top_surface_line_width", new ConfigOptionFloatOrPercent(infill_line_width, false));
            c.set_key_value("internal_solid_infill_line_width", new ConfigOptionFloatOrPercent(infill_line_width, false));
            c.set_key_value("top_surface_pattern", new ConfigOptionEnum<InfillPattern>(pattern));
            const auto *top_solid_flow = dynamic_cast<const ConfigOptionFloatsNullable *>(c.option("top_solid_infill_flow_ratio"));
            c.set_key_value("top_solid_infill_flow_ratio", new ConfigOptionFloatsNullable(top_solid_flow ? top_solid_flow->size() : 1, 1.0f));
            c.set_key_value("infill_direction", new ConfigOptionFloat(45));
            c.set_key_value("solid_infill_direction", new ConfigOptionFloat(135));
            c.set_key_value("center_of_surface_pattern", new ConfigOptionEnum<CenterOfSurfacePattern>(CenterOfSurfacePattern::Each_Surface));
            c.set_key_value("separated_infills", new ConfigOptionBool(false));
            c.set_key_value("align_infill_direction_to_model", new ConfigOptionBool(true));
            c.set_key_value("ironing_type", new ConfigOptionEnum<IroningType>(IroningType::NoIroning));
            c.set_key_value("internal_solid_infill_speed", new ConfigOptionFloatsNullable(internal_solid_speeds));
            c.set_key_value("top_surface_speed", new ConfigOptionFloatsNullable(top_surface_speeds));
            c.set_key_value("seam_slope_type", new ConfigOptionEnum<SeamScarfType>(SeamScarfType::None));
            c.set_key_value("gap_fill_target", new ConfigOptionEnum<GapFillTarget>(GapFillTarget::gftNowhere));
            print_config->set_key_value("max_volumetric_extrusion_rate_slope", new ConfigOptionFloat(0));
            c.set_key_value("calib_flowrate_topinfill_special_order", new ConfigOptionBool(true));
            c.set_key_value("top_surface_fill_order", new ConfigOptionEnum<SurfaceFillOrder>(SurfaceFillOrder::Default));

            // The flow ratio is in the name: flowrate_xxx ("m" for minus).
            std::string obj_name = _obj->name.size() > 9 ? _obj->name.substr(9) : std::string();
            if (!obj_name.empty() && obj_name[0] == 'm') obj_name[0] = '-';
            double modifier = 1.0;
            try {
                size_t used = 0;
                modifier = std::stod(obj_name, &used);
            } catch (...) {
                modifier = 1.0;
            }
            if (linear)
                c.set_key_value("print_flow_ratio", new ConfigOptionFloat((cur_flowrate + modifier) / cur_flowrate));
            else
                c.set_key_value("print_flow_ratio", new ConfigOptionFloat(1.0f + modifier / 100.f));
        }
        print_config->set_key_value("layer_height", new ConfigOptionFloat(layer_height));
        print_config->set_key_value("alternate_extra_wall", new ConfigOptionBool(false));
        print_config->set_key_value("initial_layer_print_height", new ConfigOptionFloat(first_layer_height));
        print_config->set_key_value("reduce_crossing_wall", new ConfigOptionBool(true));
        print_config->set_key_value("enable_wrapping_detection", new ConfigOptionBool(false));

        printer().set_key_value("resonance_avoidance", new ConfigOptionBool{false});
        apply_belt_mode();
        return true;
    }

    // Plater::calib_temp (and its belt printer variants)
    bool temp(Calib_Params &params, bool &custom_gcode_only)
    {
        constexpr double base_nozzle = 0.4, block_height = 10.0;
        constexpr int    temp_step = 5;
        auto *printer_config = &printer(), *filament_config = &filament(), *print_config = &print();

        if (belt_printer()) {
            if (params.test_model < 1) {
                double angle_rad = 0.;
                Vec3d  axis      = Vec3d::UnitX();
                belt_rotation(angle_rad, axis);
                return temp_belt_sectioned(params, std::abs(angle_rad));
            }
            // Discrete provini along the belt; the temperature changes by custom G-code in each.
            constexpr double PITCH_Y = 74.718;
            const double angle = printer_config->has("belt_slice_rotation_angle") ? printer_config->opt_float("belt_slice_rotation_angle") : 45.0;
            const double zone_topz = PITCH_Y * std::cos(angle * M_PI / 180.0);
            const double layer_h = print_config->has("layer_height") ? print_config->opt_float("layer_height") : 0.2;
            const double into_provino = 70.0 * layer_h;
            const int t_start = int(lround(params.start)), t_end = int(lround(params.end));
            std::vector<int> temps;
            const int tstep = (t_start >= t_end) ? -temp_step : temp_step;
            for (int t = t_start; (tstep < 0) ? (t >= t_end) : (t <= t_end); t += tstep) temps.push_back(t);
            if (temps.empty()) temps.push_back(t_start);
            if (!add_model("temperature_tower/belt_temp_tower_" + std::to_string(t_start) + "_" + std::to_string(t_end) + ".stl")) return false;
            ModelObject *obj = model.objects[0];
            obj->ensure_on_bed();
            const BoundingBoxf3 obb = obj->bounding_box_exact();
            const BoundingBoxf bed_ext = get_extents(printer_config->option<ConfigOptionPoints>("printable_area")->values);
            obj->translate_instances(Vec3d(bed_ext.center().x() - obb.center().x(), -obb.min.y(), 0.0));
            filament_config->set_key_value("nozzle_temperature_initial_layer", new ConfigOptionInts(1, temps.front()));
            filament_config->set_key_value("nozzle_temperature", new ConfigOptionInts(1, temps.front()));
            obj->config.set_key_value("brim_type", new ConfigOptionEnum<BrimType>(btNoBrim));
            obj->config.set_key_value("seam_slope_type", new ConfigOptionEnum<SeamScarfType>(SeamScarfType::None));
            obj->config.set_key_value("overhang_reverse", new ConfigOptionBool(false));
            printer_config->set_key_value("resonance_avoidance", new ConfigOptionBool{false});
            CustomGCode::Info &cg_info = model.plates_custom_gcodes[0];
            cg_info.mode = CustomGCode::Mode::SingleExtruder;
            cg_info.gcodes.clear();
            for (size_t i = 1; i < temps.size(); ++i)
                cg_info.gcodes.push_back(CustomGCode::Item{double(i) * zone_topz + into_provino, CustomGCode::Custom, 1, "",
                                                           "M104 S" + std::to_string(temps[i]) + " ; belt temp zone " + std::to_string(temps[i])});
            custom_gcode_only = true;
            return true;
        }

        if (!add_model("temperature_tower/temperature_tower.drc")) return false;
        const long start_temp = lround(params.start);
        double nozzle_diameter = base_nozzle;
        if (const auto *nd = printer_config->option<ConfigOptionFloats>("nozzle_diameter"); nd && !nd->values.empty())
            nozzle_diameter = nd->values[std::min(size_t(std::max(params.extruder_id, 0)), nd->values.size() - 1)];
        if (nozzle_diameter <= 0.0) nozzle_diameter = base_nozzle;
        const double nozzle_scale = nozzle_diameter / base_nozzle;

        // cut upper
        auto obj_bb = model.objects[0]->bounding_box_exact();
        auto block_count = lround((500 - params.end) / temp_step + 1);
        if (block_count > 0) {
            const auto new_height = block_count * block_height - EPSILON;
            if (new_height < obj_bb.size().z()) cut_horizontal(0, 0, new_height, ModelObjectCutAttribute::KeepLower);
        }
        // cut bottom
        obj_bb = model.objects[0]->bounding_box_exact();
        block_count = lround((500 - params.start) / temp_step);
        if (block_count > 0) {
            const auto new_height = block_count * block_height + EPSILON;
            if (new_height < obj_bb.size().z()) cut_horizontal(0, 0, new_height, ModelObjectCutAttribute::KeepUpper);
        }
        if (params.nozzle_based_resize && std::abs(nozzle_scale - 1.0) > EPSILON) model.objects[0]->scale(nozzle_scale, nozzle_scale, nozzle_scale);
        model.objects[0]->ensure_on_bed();

        printer_config->set_key_value("resonance_avoidance", new ConfigOptionBool{false});
        set_config_values<int, ConfigOptionInts>(filament_config, "nozzle_temperature_initial_layer", int(start_temp));
        set_config_values<int, ConfigOptionInts>(filament_config, "nozzle_temperature", int(start_temp));
        auto &c = model.objects[0]->config;
        if (params.nozzle_based_resize) c.set_key_value("layer_height", new ConfigOptionFloat(nozzle_diameter / 2));
        c.set_key_value("brim_type", new ConfigOptionEnum<BrimType>(btOuterOnly));
        c.set_key_value("brim_width", new ConfigOptionFloat(5.0));
        c.set_key_value("brim_object_gap", new ConfigOptionFloat(0.0));
        c.set_key_value("alternate_extra_wall", new ConfigOptionBool(false));
        c.set_key_value("seam_slope_type", new ConfigOptionEnum<SeamScarfType>(SeamScarfType::None));
        c.set_key_value("overhang_reverse", new ConfigOptionBool(false));
        c.set_key_value("precise_z_height", new ConfigOptionBool(false));
        print_config->set_key_value("enable_wrapping_detection", new ConfigOptionBool(false));
        if (params.nozzle_based_resize) print_config->set_key_value("initial_layer_print_height", new ConfigOptionFloat(nozzle_diameter / 2));
        return true;
    }

    // Plater::_calib_temp_belt_sectioned: one block of the tower per temperature, along the belt.
    bool temp_belt_sectioned(const Calib_Params &params, double belt_angle_rad)
    {
        constexpr double base_nozzle = 0.4, block_height = 10.0;
        constexpr int    temp_step = 5;
        auto *printer_config = &printer(), *filament_config = &filament(), *print_config = &print();
        const long start_temp = lround(params.start), end_temp = lround(params.end);
        const int  n_blocks   = std::max(1, int((start_temp - end_temp) / temp_step) + 1);
        double nozzle_diameter = base_nozzle;
        if (const auto *nd = printer_config->option<ConfigOptionFloats>("nozzle_diameter"); nd && !nd->values.empty())
            nozzle_diameter = nd->values[std::min(size_t(std::max(params.extruder_id, 0)), nd->values.size() - 1)];
        if (nozzle_diameter <= 0.0) nozzle_diameter = base_nozzle;
        const double nozzle_scale = nozzle_diameter / base_nozzle;

        std::vector<ModelObject *> blocks;
        for (int i = 0; i < n_blocks; ++i) {
            const long   temp         = start_temp - long(i) * temp_step;
            const size_t count_before = model.objects.size();
            add_model("temperature_tower/temperature_tower.drc");
            if (model.objects.size() <= count_before) break;
            size_t obj_idx = model.objects.size() - 1;
            const double block_bottom = double(lround(double(500 - temp) / temp_step)) * block_height;
            const auto obj_bb = model.objects[obj_idx]->bounding_box_exact();
            if (block_bottom + block_height < obj_bb.size().z()) {
                cut_horizontal(obj_idx, 0, block_bottom + block_height - EPSILON, ModelObjectCutAttribute::KeepLower);
                obj_idx = model.objects.size() - 1;
            }
            if (block_bottom > 0) {
                cut_horizontal(obj_idx, 0, block_bottom + EPSILON, ModelObjectCutAttribute::KeepUpper);
                obj_idx = model.objects.size() - 1;
            }
            ModelObject *obj = model.objects[obj_idx];
            if (std::abs(nozzle_scale - 1.0) > EPSILON) obj->scale(nozzle_scale, nozzle_scale, nozzle_scale);
            obj->name = std::string("temp_") + std::to_string(temp);
            obj->config.set_key_value("layer_height", new ConfigOptionFloat(nozzle_diameter / 2));
            obj->config.set_key_value("alternate_extra_wall", new ConfigOptionBool(false));
            obj->config.set_key_value("seam_slope_type", new ConfigOptionEnum<SeamScarfType>(SeamScarfType::None));
            obj->config.set_key_value("overhang_reverse", new ConfigOptionBool(false));
            obj->config.set_key_value("precise_z_height", new ConfigOptionBool(false));
            obj->ensure_on_bed();
            blocks.push_back(obj);
        }
        const double cot_a  = 1. / std::max(0.1, std::tan(belt_angle_rad));
        double       cursor = 20.;
        for (ModelObject *obj : blocks) {
            ModelInstance      *inst = obj->instances.front();
            const BoundingBoxf3 bb   = obj->instance_bounding_box(0);
            inst->set_offset(Y, inst->get_offset(Y) + (cursor - bb.min.y()));
            obj->invalidate_bounding_box();
            cursor += bb.size().y() + bb.size().z() * cot_a + 5.;
        }
        printer_config->set_key_value("resonance_avoidance", new ConfigOptionBool{false});
        filament_config->set_key_value("nozzle_temperature_initial_layer", new ConfigOptionInts(1, int(start_temp)));
        filament_config->set_key_value("nozzle_temperature", new ConfigOptionInts(1, int(start_temp)));
        print_config->set_key_value("enable_wrapping_detection", new ConfigOptionBool(false));
        print_config->set_key_value("initial_layer_print_height", new ConfigOptionFloat(nozzle_diameter / 2));
        print_config->set_key_value("skirt_loops", new ConfigOptionInt(0));
        return !blocks.empty();
    }

    // Plater::calib_max_vol_speed
    bool max_vol_speed(Calib_Params &params)
    {
        if (!add_model("volumetric_speed/SpeedTestStructure.drc")) return false;
        auto *print_config = &print(), *filament_config = &filament(), *printer_config = &printer();
        ModelObject *obj = model.objects[0];
        auto &obj_cfg = obj->config;

        const BoundingBoxf bed_ext = get_extents(printer_config->option<ConfigOptionPoints>("printable_area")->values);
        const auto scale_obj = (bed_ext.size().x() - 10) / obj->bounding_box_exact().size().x();
        if (scale_obj < 1.0) obj->scale(scale_obj, 1, 1);

        const double nozzle_diameter = printer_config->option<ConfigOptionFloats>("nozzle_diameter")->values[0];
        const double line_width = nozzle_diameter * 1.75, layer_height = nozzle_diameter * 0.8;
        auto *max_lh = printer_config->option<ConfigOptionFloats>("max_layer_height");
        for (size_t i = 0; i < max_lh->values.size(); ++i)
            if (max_lh->values[i] < layer_height) max_lh->values[i] = layer_height;

        const double filament_max_volumetric_speed = filament_config->option<ConfigOptionFloats>("filament_max_volumetric_speed")->get_at(0);
        set_config_values<double, ConfigOptionFloats>(filament_config, "filament_max_volumetric_speed", std::max(filament_max_volumetric_speed, 200.0));
        filament_config->set_key_value("slow_down_layer_time", new ConfigOptionFloats{0.0});
        printer_config->set_key_value("resonance_avoidance", new ConfigOptionBool{false});
        obj_cfg.set_key_value("enable_overhang_speed", new ConfigOptionBoolsNullable(1, false));
        obj_cfg.set_key_value("wall_loops", new ConfigOptionInt(1));
        obj_cfg.set_key_value("alternate_extra_wall", new ConfigOptionBool(false));
        obj_cfg.set_key_value("top_shell_layers", new ConfigOptionInt(0));
        obj_cfg.set_key_value("bottom_shell_layers", new ConfigOptionInt(0));
        obj_cfg.set_key_value("sparse_infill_density", new ConfigOptionPercent(0));
        obj_cfg.set_key_value("outer_wall_line_width", new ConfigOptionFloatOrPercent(line_width, false));
        obj_cfg.set_key_value("layer_height", new ConfigOptionFloat(layer_height));
        obj_cfg.set_key_value("brim_type", new ConfigOptionEnum<BrimType>(btOuterAndInner));
        obj_cfg.set_key_value("brim_width", new ConfigOptionFloat(5.0));
        obj_cfg.set_key_value("brim_object_gap", new ConfigOptionFloat(0.0));
        obj_cfg.set_key_value("precise_z_height", new ConfigOptionBool(false));
        print_config->set_key_value("timelapse_type", new ConfigOptionEnum<TimelapseType>(tlTraditional));
        print_config->set_key_value("spiral_mode", new ConfigOptionBool(true));
        print_config->set_key_value("max_volumetric_extrusion_rate_slope", new ConfigOptionFloat(0));
        print_config->set_key_value("enable_wrapping_detection", new ConfigOptionBool(false));

        const auto obj_bb = obj->bounding_box_exact();
        const auto height = (params.end - params.start + 1) / params.step;
        if (height < obj_bb.size().z()) cut_horizontal(0, 0, height, ModelObjectCutAttribute::KeepLower);
        apply_belt_mode();

        // G-code export steps the speed, mm/s.
        const auto mm3_per_mm = Flow(line_width, layer_height, nozzle_diameter).mm3_per_mm() *
                                filament_config->option<ConfigOptionFloatsNullable>("filament_flow_ratio")->get_at(0);
        params.end   = params.end / mm3_per_mm;
        params.start = params.start / mm3_per_mm;
        params.step  = params.step / mm3_per_mm;
        return true;
    }

    // Plater::calib_retraction
    bool retraction(const Calib_Params &params)
    {
        if (!add_model("retraction/retraction_tower.drc")) return false;
        auto *print_config = &print(), *printer_config = &printer();
        ModelObject *obj = model.objects[0];
        print_config->set_key_value("enable_wrapping_detection", new ConfigOptionBool(false));
        print_config->set_key_value("wipe_inward", new ConfigOptionBool(false));
        const float nozzle_diameter = printer_config->option<ConfigOptionFloats>("nozzle_diameter")->get_at(0);
        const float layer_height = nozzle_diameter <= 0.1f ? 0.05f : nozzle_diameter <= 0.2f ? 0.1f : 0.2f;
        auto *max_lh = printer_config->option<ConfigOptionFloats>("max_layer_height");
        for (size_t i = 0; i < max_lh->values.size(); ++i)
            if (max_lh->values[i] < layer_height) max_lh->values[i] = layer_height;
        printer_config->set_key_value("resonance_avoidance", new ConfigOptionBool{false});
        printer_config->set_key_value("use_firmware_retraction", new ConfigOptionBool(false));
        auto &c = obj->config;
        c.set_key_value("wall_loops", new ConfigOptionInt(2));
        c.set_key_value("top_shell_layers", new ConfigOptionInt(0));
        c.set_key_value("bottom_shell_layers", new ConfigOptionInt(3));
        c.set_key_value("sparse_infill_density", new ConfigOptionPercent(0));
        print_config->set_key_value("initial_layer_print_height", new ConfigOptionFloat(layer_height));
        c.set_key_value("layer_height", new ConfigOptionFloat(layer_height));
        c.set_key_value("alternate_extra_wall", new ConfigOptionBool(false));
        c.set_key_value("seam_position", new ConfigOptionEnum<SeamPosition>(spAligned));
        c.set_key_value("wall_sequence", new ConfigOptionEnum<WallSequence>(WallSequence::InnerOuter));
        c.set_key_value("overhang_reverse", new ConfigOptionBool(false));
        c.set_key_value("precise_z_height", new ConfigOptionBool(false));
        c.set_key_value("seam_slope_type", new ConfigOptionEnum<SeamScarfType>(SeamScarfType::None));
        const auto obj_bb = obj->bounding_box_exact();
        const auto height = 1.0 + 0.4 + ((params.end - params.start)) / params.step - EPSILON;
        if (height < obj_bb.size().z()) cut_horizontal(0, 0, height, ModelObjectCutAttribute::KeepLower);
        apply_belt_mode();
        return true;
    }

    // Plater::calib_VFA
    bool vfa(Calib_Params &params)
    {
        if (!add_model("vfa/vfa.drc")) return false;
        auto *print_config = &print(), *filament_config = &filament(), *printer_config = &printer();
        double nozzle_diameter = vfa_base_nozzle_diameter;
        if (const auto *nd = printer_config->option<ConfigOptionFloats>("nozzle_diameter"); nd && !nd->values.empty())
            nozzle_diameter = nd->values[std::min(size_t(std::max(params.extruder_id, 0)), nd->values.size() - 1)];
        if (nozzle_diameter <= 0.0) nozzle_diameter = vfa_base_nozzle_diameter;
        const double layer_height = params.vfa_layer_height > 0.0 ? params.vfa_layer_height : nozzle_diameter / 2.0;

        const auto obj_bb = model.objects[0]->bounding_box_exact();
        const auto height = vfa_base_block_height * ((params.end - params.start) / params.step + 1) - EPSILON;
        if (height < obj_bb.size().z()) cut_horizontal(0, 0, height, ModelObjectCutAttribute::KeepLower);
        if (params.nozzle_based_resize) {
            const double xy_scale = nozzle_diameter / vfa_base_nozzle_diameter;
            const double z_scale  = (vfa_layers_per_block * layer_height) / vfa_base_block_height;
            if (std::abs(xy_scale - 1.0) > EPSILON || std::abs(z_scale - 1.0) > EPSILON) model.objects[0]->scale(xy_scale, xy_scale, z_scale);
        }
        model.objects[0]->ensure_on_bed();

        printer_config->set_key_value("resonance_avoidance", new ConfigOptionBool{false});
        filament_config->set_key_value("slow_down_layer_time", new ConfigOptionFloats{0.0});
        set_config_values<bool, ConfigOptionBoolsNullable>(print_config, "enable_overhang_speed", false);
        print_config->set_key_value("timelapse_type", new ConfigOptionEnum<TimelapseType>(tlTraditional));
        print_config->set_key_value("wall_loops", new ConfigOptionInt(1));
        print_config->set_key_value("alternate_extra_wall", new ConfigOptionBool(false));
        print_config->set_key_value("top_shell_layers", new ConfigOptionInt(0));
        print_config->set_key_value("bottom_shell_layers", new ConfigOptionInt(1));
        print_config->set_key_value("sparse_infill_density", new ConfigOptionPercent(0));
        print_config->set_key_value("detect_thin_wall", new ConfigOptionBool(false));
        print_config->set_key_value("spiral_mode", new ConfigOptionBool(true));
        print_config->set_key_value("enable_wrapping_detection", new ConfigOptionBool(false));
        print_config->set_key_value("precise_z_height", new ConfigOptionBool(false));
        if (params.nozzle_based_resize) {
            print_config->set_key_value("initial_layer_print_height", new ConfigOptionFloat(layer_height));
            model.objects[0]->config.set_key_value("layer_height", new ConfigOptionFloat(layer_height));
        }
        auto &c = model.objects[0]->config;
        c.set_key_value("brim_type", new ConfigOptionEnum<BrimType>(btOuterOnly));
        c.set_key_value("brim_width", new ConfigOptionFloat(3.0));
        c.set_key_value("brim_object_gap", new ConfigOptionFloat(0.0));
        apply_belt_mode();
        params.vfa_layer_height = params.nozzle_based_resize ? layer_height : 0.0;
        return true;
    }

    // The settings Plater::calib_input_shaping_freq, _damp and Calib_Cornering share.
    void fast_tower_settings(bool emit_shaping)
    {
        auto *print_config = &print(), *filament_config = &filament(), *printer_config = &printer();
        zero_pressure_advance_where_disabled(filament_config);
        printer_config->set_key_value("resonance_avoidance", new ConfigOptionBool{false});
        printer_config->set_key_value("input_shaping_emit", new ConfigOptionBool{emit_shaping});
        filament_config->set_key_value("slow_down_layer_time", new ConfigOptionFloats{0.0});
        filament_config->set_key_value("slow_down_min_speed", new ConfigOptionFloats{0.0});
        filament_config->set_key_value("slow_down_for_layer_cooling", new ConfigOptionBools{false});
        print_config->set_key_value("timelapse_type", new ConfigOptionEnum<TimelapseType>(tlTraditional));
        print_config->set_key_value("wall_loops", new ConfigOptionInt(1));
        print_config->set_key_value("top_shell_layers", new ConfigOptionInt(0));
        print_config->set_key_value("bottom_shell_layers", new ConfigOptionInt(1));
        print_config->set_key_value("sparse_infill_density", new ConfigOptionPercent(0));
        print_config->set_key_value("detect_thin_wall", new ConfigOptionBool(false));
        print_config->set_key_value("spiral_mode", new ConfigOptionBool(true));
        print_config->set_key_value("spiral_mode_smooth", new ConfigOptionBool(false));
        print_config->set_key_value("bottom_surface_pattern", new ConfigOptionEnum<InfillPattern>(ipRectilinear));
        const double machine_max_speed = std::min(printer_config->option<ConfigOptionFloats>("machine_max_speed_x")->get_at(0),
                                                  printer_config->option<ConfigOptionFloats>("machine_max_speed_y")->get_at(0));
        const double machine_max_acceleration = printer_config->option<ConfigOptionFloats>("machine_max_acceleration_extruding")->get_at(0);
        set_config_values<double, ConfigOptionFloatsNullable>(print_config, "outer_wall_speed", machine_max_speed);
        set_config_values<double, ConfigOptionFloatsNullable>(print_config, "default_acceleration", machine_max_acceleration);
        set_config_values<double, ConfigOptionFloatsNullable>(print_config, "outer_wall_acceleration", machine_max_acceleration);
        print_config->set_key_value("precise_z_height", new ConfigOptionBool(false));
        auto &c = model.objects[0]->config;
        c.set_key_value("brim_type", new ConfigOptionEnum<BrimType>(btOuterOnly));
        c.set_key_value("brim_width", new ConfigOptionFloat(3.0));
        c.set_key_value("brim_object_gap", new ConfigOptionFloat(0.0));
    }

    // Plater::calib_input_shaping_freq and calib_input_shaping_damp
    bool input_shaping(const Calib_Params &params, bool freq)
    {
        if (!add_model(params.test_model < 1 ? "input_shaping/ringing_tower.drc" : "input_shaping/fast_tower_test.drc")) return false;
        if (params.test_model < 1) flip_ringing_tower();
        auto *print_config = &print(), *printer_config = &printer();
        const auto *gcode_flavor_option = printer_config->option<ConfigOptionEnum<GCodeFlavor>>("gcode_flavor");
        if (has_junction_deviation(printer_config)) {
            printer_config->set_key_value("machine_max_junction_deviation",
                new ConfigOptionFloats{std::max(printer_config->option<ConfigOptionFloats>("machine_max_junction_deviation")->values.front(), 0.25)});
            set_config_values<double, ConfigOptionFloatsNullable>(print_config, "default_junction_deviation", 0);
        } else {
            const double jerk_value = (gcode_flavor_option && gcode_flavor_option->value == GCodeFlavor::gcfKlipper) ? 5.0 : 10.0;
            printer_config->set_key_value("machine_max_jerk_x",
                new ConfigOptionFloats{std::max(printer_config->option<ConfigOptionFloats>("machine_max_jerk_x")->values.front(), jerk_value)});
            printer_config->set_key_value("machine_max_jerk_y",
                new ConfigOptionFloats{std::max(printer_config->option<ConfigOptionFloats>("machine_max_jerk_y")->values.front(), jerk_value)});
            set_config_values<double, ConfigOptionFloatsNullable>(print_config, "default_jerk", 0);
        }
        if (freq) print_config->set_key_value("layer_height", new ConfigOptionFloat(0.2));
        set_config_values<bool, ConfigOptionBools>(print_config, "enable_overhang_speed", false);
        // A 100% factor sends Klipper MINIMUM_CRUISE_RATIO=0 with every acceleration change.
        print_config->set_key_value("accel_to_decel_enable", new ConfigOptionBool(true));
        print_config->set_key_value("accel_to_decel_factor", new ConfigOptionPercent(100));
        fast_tower_settings(false);
        apply_belt_mode();
        return true;
    }

    // Plater::Calib_Cornering
    bool cornering(const Calib_Params &params)
    {
        const char *file = params.test_model == 0 ? "input_shaping/ringing_tower.drc" :
                           params.test_model == 1 ? "input_shaping/fast_tower_test.drc" :
                                                    "cornering/SCV-V2.drc";
        if (!add_model(file)) return false;
        if (params.test_model == 0) flip_ringing_tower();
        auto *print_config = &print(), *filament_config = &filament(), *printer_config = &printer();
        if (has_junction_deviation(printer_config)) {
            printer_config->set_key_value("machine_max_junction_deviation", new ConfigOptionFloats{params.end});
            set_config_values<double, ConfigOptionFloatsNullable>(print_config, "default_junction_deviation", 0);
        } else {
            printer_config->set_key_value("machine_max_jerk_x", new ConfigOptionFloats{params.end});
            printer_config->set_key_value("machine_max_jerk_y", new ConfigOptionFloats{params.end});
            set_config_values<double, ConfigOptionFloatsNullable>(print_config, "default_jerk", 0);
        }
        printer_config->set_key_value("input_shaping_type", new ConfigOptionEnum<InputShaperType>(InputShaperType::Disable));
        const double filament_max_volumetric_speed = filament_config->option<ConfigOptionFloats>("filament_max_volumetric_speed")->get_at(0);
        filament_config->set_key_value("filament_max_volumetric_speed", new ConfigOptionFloats{std::max(filament_max_volumetric_speed, 200.0)});
        set_config_values<bool, ConfigOptionBools>(print_config, "enable_overhang_speed", false);
        fast_tower_settings(true);
        apply_belt_mode();
        return true;
    }
};

bool params_from_json(const json &j, Calib_Params &p)
{
    const std::string mode = j.value("mode", "none");
    bool found = false;
    for (const auto &[m, n] : MODES)
        if (mode == n) { p.mode = m; found = true; }
    if (!found) return false;
    p.extruder_id         = j.value("extruder_id", 0);
    p.start               = j.value("start", 0.0);
    p.end                 = j.value("end", 1.0);
    p.step                = j.value("step", 0.1);
    p.print_numbers       = j.value("print_numbers", false);
    p.freqStartX          = j.value("freqStartX", 0.0);
    p.freqEndX            = j.value("freqEndX", 1.0);
    p.freqStartY          = j.value("freqStartY", 0.0);
    p.freqEndY            = j.value("freqEndY", 1.0);
    p.test_model          = j.value("test_model", 0);
    p.shaper_type         = j.value("shaper_type", std::string());
    p.accelerations       = j.value("accelerations", std::vector<double>{});
    p.speeds              = j.value("speeds", std::vector<double>{});
    p.vfa_layer_height    = j.value("vfa_layer_height", 0.0);
    p.nozzle_based_resize = j.value("nozzle_based_resize", true);
    return true;
}

} // namespace

namespace orca_bridge {
bool calib_params_from_json(const json &j, Calib_Params &p) { return params_from_json(j, p); }
} // namespace orca_bridge

extern "C" {

// {params{mode, …}, flow?{linear, pass, pattern}, assets, out} → {calib|null, notices[]}
const char *orca_presets_calib(void *p, const char *json_text)
{
    using namespace orca_bridge;
    PresetBundle *bundle = presets_bundle(p);
    if (!bundle) { presets_fail(p, ORCA_INVALID_CONFIG, "Presets not loaded"); return nullptr; }
    try {
        const json j = json::parse(json_text ? json_text : "", nullptr, false);
        Calib_Params params;
        if (!j.is_object() || !params_from_json(j.value("params", json::object()), params)) {
            presets_fail(p, ORCA_INVALID_INPUT, "Bad calibration request");
            return nullptr;
        }
        Calib c{*bundle, j.value("assets", std::string("/calib")), Model()};
        bool ok = false, custom_gcode_only = false;
        switch (params.mode) {
        case CalibMode::Calib_PA_Line:
        case CalibMode::Calib_PA_Pattern:
        case CalibMode::Calib_PA_Tower: ok = c.pa(params); break;
        case CalibMode::Calib_Flow_Rate: {
            const json f = j.value("flow", json::object());
            ok = c.flowrate(f.value("linear", true), f.value("pass", 1),
                            f.value("pattern", std::string()) == "monotonic" ? ipMonotonic : ipArchimedeanChords);
            break;
        }
        case CalibMode::Calib_Temp_Tower: ok = c.temp(params, custom_gcode_only); break;
        case CalibMode::Calib_Vol_speed_Tower: ok = c.max_vol_speed(params); break;
        case CalibMode::Calib_Retraction_tower: ok = c.retraction(params); break;
        case CalibMode::Calib_VFA_Tower: ok = c.vfa(params); break;
        case CalibMode::Calib_Input_shaping_freq: ok = c.input_shaping(params, true); break;
        case CalibMode::Calib_Input_shaping_damp: ok = c.input_shaping(params, false); break;
        case CalibMode::Calib_Cornering: ok = c.cornering(params); break;
        default: break;
        }
        if (!ok || c.model.objects.empty()) {
            presets_fail(p, ORCA_INVALID_INPUT, "Could not load the calibration model");
            return nullptr;
        }
        bundle->update_compatible(PresetSelectCompatibleType::Never);

        const std::string out = j.value("out", std::string("/out/calib.3mf"));
        boost::filesystem::create_directories(boost::filesystem::path(out).parent_path());
        StoreParams sp;
        sp.path     = out;
        sp.model    = &c.model;
        sp.config   = nullptr;
        sp.strategy = SaveStrategy::Silence | SaveStrategy::Zip64;
        if (!store_bbs_3mf(sp)) {
            presets_fail(p, ORCA_INTERNAL, "Could not save the calibration model");
            return nullptr;
        }
        // The flow ratio test and the belt temperature provini set no parameters (desktop).
        const bool none = params.mode == CalibMode::Calib_Flow_Rate || custom_gcode_only;
        return presets_ret(p, json{{"calib", none ? json() : params_json(params)}, {"notices", c.notices}}.dump());
    } catch (const std::exception &ex) {
        presets_fail(p, ORCA_INTERNAL, "Could not make the calibration model", ex.what());
        return nullptr;
    }
}

// VFA_Test_Dlg::on_start's check of the end speed against the filament's max volumetric speed:
// {start, end, step, nozzle_based_resize} → {exceeds, max_vol_speed, default_lh, limit, chosen_lh,
// min_lh, new_end}. `limit`: the outer wall speed allowed at the default layer height; `chosen_lh`:
// the largest layer height of the compatible process presets (not above the default) that reaches
// the end speed (0: none); `min_lh` and `new_end`: the smallest one and the end speed it allows
// (0: no compatible process presets).
const char *orca_presets_calib_vfa(void *p, const char *json_text)
{
    using namespace orca_bridge;
    PresetBundle *bundle = presets_bundle(p);
    if (!bundle) { presets_fail(p, ORCA_INVALID_CONFIG, "Presets not loaded"); return nullptr; }
    const json j = json::parse(json_text ? json_text : "", nullptr, false);
    if (!j.is_object()) { presets_fail(p, ORCA_INVALID_INPUT, "Bad request"); return nullptr; }
    const double start = j.value("start", 0.0), end = j.value("end", 0.0), step = j.value("step", 1.0);
    const bool resize = j.value("nozzle_based_resize", true);
    const auto &printer_config  = bundle->printers.get_edited_preset().config;
    const auto &print_config    = bundle->prints.get_edited_preset().config;
    const auto &filament_config = bundle->filaments.get_edited_preset().config;
    auto get_at = [](const ConfigOptionFloats *opt, double fallback) {
        return opt == nullptr || opt->values.empty() ? fallback : opt->values.front();
    };
    const double nozzle_diameter = get_at(printer_config.option<ConfigOptionFloats>("nozzle_diameter"), vfa_base_nozzle_diameter);
    double preset_lh = nozzle_diameter / 2.0;
    if (const auto *lh_opt = print_config.option<ConfigOptionFloat>("layer_height"); lh_opt && lh_opt->value > 0.0) preset_lh = lh_opt->value;
    const double default_lh     = resize ? nozzle_diameter / 2.0 : preset_lh;
    const double max_vol_speed  = get_at(filament_config.option<ConfigOptionFloats>("filament_max_volumetric_speed"), 0.0);
    const double machine_min_lh = get_at(printer_config.option<ConfigOptionFloats>("min_layer_height"), 0.0);
    const double machine_max_lh = get_at(printer_config.option<ConfigOptionFloats>("max_layer_height"), 0.0);
    double line_width = print_config.get_abs_value("outer_wall_line_width", nozzle_diameter);
    if (line_width <= 0.0) line_width = print_config.get_abs_value("line_width", nozzle_diameter);
    if (line_width <= 0.0) line_width = nozzle_diameter;
    auto speed_limit_for_lh = [&](double lh) {
        const double mm3_per_mm = Flow(line_width, lh, nozzle_diameter).mm3_per_mm();
        return mm3_per_mm > 0.0 ? max_vol_speed / mm3_per_mm : 1e9;
    };
    std::vector<double> candidates;
    for (const auto &preset : bundle->prints.get_presets()) {
        if (!preset.is_compatible || preset.is_default) continue;
        const auto *lh_opt = preset.config.option<ConfigOptionFloat>("layer_height");
        if (lh_opt == nullptr || lh_opt->value <= 0.0) continue;
        const double lh = lh_opt->value;
        if ((machine_min_lh > 0.0 && lh < machine_min_lh - 1e-6) || (machine_max_lh > 0.0 && lh > machine_max_lh + 1e-6)) continue;
        candidates.push_back(lh);
    }
    std::sort(candidates.begin(), candidates.end());
    candidates.erase(std::unique(candidates.begin(), candidates.end(), [](double a, double b) { return std::abs(a - b) < 1e-6; }),
                     candidates.end());
    double chosen_lh = 0.0;
    for (auto it = candidates.rbegin(); it != candidates.rend(); ++it) {
        if (*it > default_lh + 1e-6) continue;
        if (speed_limit_for_lh(*it) >= end) { chosen_lh = *it; break; }
    }
    double min_lh = 0.0, new_end = 0.0;
    if (!candidates.empty()) {
        min_lh  = candidates.front();
        new_end = std::floor(speed_limit_for_lh(min_lh) / step) * step;
        if (new_end < start + step) new_end = start + step;
    }
    const bool exceeds = max_vol_speed > 0.0 && nozzle_diameter > 0.0 && end > speed_limit_for_lh(default_lh);
    return presets_ret(p, json{{"exceeds", exceeds}, {"max_vol_speed", max_vol_speed}, {"default_lh", default_lh},
                               {"limit", speed_limit_for_lh(default_lh)}, {"chosen_lh", chosen_lh}, {"min_lh", min_lh},
                               {"new_end", new_end}}
                              .dump());
}

} // extern "C"
