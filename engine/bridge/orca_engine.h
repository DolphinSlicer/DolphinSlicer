/* DolphinSlicer engine C API.
 *
 * A deliberately small surface over OrcaSlicer's libslic3r. All strings are UTF-8, all JSON is
 * OrcaSlicer's own config JSON. Files are exchanged through the Emscripten virtual FS (MEMFS):
 * the host writes inputs (e.g. /in/model.3mf) and reads outputs (e.g. /out/plate_1.gcode).
 *
 * Threading: in the single-threaded build orca_slice_start() runs to completion before it
 * returns. In the multithreaded build it starts the slice on a pthread and returns at once; the
 * host polls orca_slice_poll()/orca_progress() and may call orca_cancel() at any time.
 *
 * Returned `const char*` stay valid until the next call on the same engine.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
#ifndef DOLPHIN_SLICER_ENGINE_H
#define DOLPHIN_SLICER_ENGINE_H

#ifdef __cplusplus
extern "C" {
#endif

#define ORCA_API_VERSION 3   /* 3: schema, preset editing/saving/import */

/* Status codes (also the "code" field of orca_last_error()). */
enum orca_status {
    ORCA_OK             = 0,
    ORCA_RUNNING        = 1,   /* orca_slice_poll(): slice still in progress */
    ORCA_INVALID_INPUT  = -1,  /* bad/unsupported model file */
    ORCA_INVALID_CONFIG = -2,  /* config JSON rejected */
    ORCA_VALIDATE_ERROR = -3,  /* Print::validate() refused the plate (message says why) */
    ORCA_SLICE_FAILED   = -4,  /* slicing or G-code export threw */
    ORCA_CANCELLED      = -5,
    ORCA_OOM            = -6,  /* std::bad_alloc */
    ORCA_EMPTY_PLATE    = -7,  /* no printable object on the plate */
    ORCA_INTERNAL       = -8
};

int         orca_api_version(void);
/* JSON: {"api":1,"orca_version":"2.5.0","orca_sha":"…","threads":bool,"build":"st"|"mt"} */
const char *orca_engine_info(void);

void       *orca_create(void);
void        orca_destroy(void *engine);

/* Load a model/project file already written to MEMFS. format: "3mf", "stl", "obj", or NULL to
 * infer from the extension. A 3MF keeps its plates, positions and per-object settings; other
 * formats get one default instance centred on the bed. */
int         orca_load_model(void *engine, const char *path, const char *format);

/* Append the objects of another file (geometry only, like importing into an open project). */
int         orca_add_model(void *engine, const char *path, const char *format);
/* JSON {"objects":[{name,parts,modifiers,triangles,has_config,bbox:{min,max},
 *        instances:[{matrix:[16, column-major],printable}]}], "plates":[{index,name}], "bbl_3mf"} */
const char *orca_model_info(void *engine);
/* Binary meshes for display, one record per object in model order (object coordinates):
 * u32 nverts, u32 ntris, f32 xyz[nverts], u32 idx[3*ntris]; little-endian. */
int         orca_export_meshes(void *engine, const char *out_path);
int         orca_export_3mf(void *engine, const char *out_path);   /* the plate as a project 3MF */
/* Replace the object list and instance transforms:
 * {"objects":[{"index":<current index>,"instances":[{"matrix":[16 numbers, column-major]}],
 *   "supports"?:[painted supports per model part, as orca_paint_data]}]}
 * Objects not listed are deleted; listed objects take the given order. An index listed again is a
 * copy of that object. */
int         orca_set_layout(void *engine, const char *json);

/* Desktop's Arrange for the loaded model, with the config set (call orca_set_layout and
 * orca_set_config first). JSON {"objects":[{"instances":[{"matrix":[16],"bed":int}]}]} in model
 * order; bed 0 is the plate, more are further plates to its right, -1 could not be placed (left
 * where it was). NULL on failure (orca_last_error). */
const char *orca_arrange(void *engine);

/* Set the full, flattened print+printer+filament config (OrcaSlicer "project_settings" JSON,
 * as written by the desktop CLI's --export-settings or by the web app's preset resolver). */
int         orca_set_config(void *engine, const char *json);

/* The calibration test the plate is (orca_presets_calib's "calib"; null: none), for its G-code. */
int         orca_set_calib(void *engine, const char *json);

/* Slice one plate (1-based) and write G-code to out_path. */
int         orca_slice_start(void *engine, int plate, const char *out_path);
int         orca_slice_poll(void *engine);       /* ORCA_RUNNING or the final status */
void        orca_cancel(void *engine);           /* thread-safe */
/* JSON {"percent":int,"message":"…"} — safe to call while a slice runs. */
const char *orca_progress(void *engine);
/* JSON with slice statistics after a successful slice (print time, filament use, layers…). */
const char *orca_result(void *engine);
/* Read a G-code file as desktop's G-code viewer does (GCodeProcessor::process_file), in place of
 * the last slice's moves. */
int         orca_process_gcode(void *engine, const char *path);
/* The moves of the last slice or processed G-code for the preview, as desktop's preview gets them
 * (LibVGCodeWrapper.cpp convert()). `count` vertices as arrays at `data` (`bytes` long, valid
 * until the next call or orca_destroy): positions (3 float each), height, width, speed, actual
 * speed, mm3 per mm, fan speed, temperature, pressure advance, acceleration, jerk (float each),
 * layer (uint32), then role, move type, extruder, color (one byte each). Returns JSON {data, bytes,
 * count, layer_times[], tool_colors[], print_colors[], filaments[{id, m, g}], time_s, filament_m,
 * filament_g, cost, spiral_vase}; NULL on failure. */
const char *orca_export_preview(void *engine);
/* JSON {"code":int,"message":"…","detail":"…"} for the last failure. */
const char *orca_last_error(void *engine);

/* JSON dump of OrcaSlicer's PrintConfigDef (key → type, default, enum, label, tooltip, …).
 * Used at build time to generate the settings UI. */
const char *orca_config_schema(void);

/* ── Presets (OrcaSlicer's PresetBundle) ─────────────────────────────────────────────
 * Vendor trees go in MEMFS at <data_dir>/system/<Vendor>.json + <Vendor>/…, user presets at
 * <data_dir>/user/default/{machine,process,filament}/*.json. */
void       *orca_presets_create(void);
void        orca_presets_destroy(void *presets);
int         orca_presets_load(void *presets, const char *data_dir);
const char *orca_presets_list(void *presets);              /* {"printers":[…]} */
/* {printer?, variant?, process?, filaments?, defaults?, bed_type?}: defaults=true picks the
 * printer's default process and filament unless given; variant picks the printer preset of the
 * same model with that nozzle; bed_type sets the plate type (curr_bed_type), else another printer
 * gets its default. */
int         orca_presets_select(void *presets, const char *json);
/* The preset types whose unsaved edits that selection would drop: {"lost": [types]}. */
const char *orca_presets_select_loses(void *presets, const char *json);
/* A project's settings ({name, config: {key: value}}): its presets selected, what differs as
   unsaved edits → {"gcode": [changed G-code keys of the printer and filament]}; NULL on error. */
const char *orca_presets_load_project(void *presets, const char *json);
const char *orca_presets_state(void *presets);             /* selection + compatible lists */
const char *orca_presets_full_config(void *presets);       /* config JSON for orca_set_config */
const char *orca_presets_last_error(void *presets);
/* Settings of the edited preset of one type ("print" | "filament" | "printer"): {name, system,
 * user, inherits, file, dirty[], from_system[], variant_index, extruders[], variant_keys[],
 * values{}}. `extruder` (0-based): which of the printer's extruders variant_index and the option
 * states are for; extruders[] holds that index for each of them. */
const char *orca_presets_values(void *presets, const char *type, int extruder);
/* {type, values{key: "value" | {index, value} | {elements[]}}}; vectors are returned by
 * orca_presets_values as arrays of element strings, and edited one element at a time or as a
 * whole list. String elements are taken verbatim (no ';' splitting). */
int         orca_presets_edit(void *presets, const char *json);
int         orca_presets_reset(void *presets, const char *json);  /* {type, keys?[], to: "saved"|"system"} */
const char *orca_presets_save(void *presets, const char *json);   /* {type, name, detach?} → {name, file} */
int         orca_presets_delete(void *presets, const char *json); /* {type, name} */
const char *orca_presets_import(void *presets, const char *json); /* {files[]} → {imported[]} */
/* {printer} → {processes[], filaments[]}: presets a new printer can start from (compatible with it) */
const char *orca_presets_templates(void *presets, const char *json);
/* Desktop's Create Printer: {model, nozzle, template, from_template, area?, height?, bed_from?,
 * processes[], filaments[], overwrite?} → {printer, created[]} */
const char *orca_presets_create_printer(void *presets, const char *json);
/* {model} → {processes[], filaments[]}: the user's presets whose compatible printers name a printer of the model. */
const char *orca_presets_linked(void *presets, const char *json);
/* [{name, alias, filament_id, user, visible, inherits, type, printers[]}]: every filament preset */
const char *orca_presets_filament_list(void *presets);
/* Desktop's Create Filament: {name, vendor, type, items[{printer, preset}], overwrite?} → {created[], filament_id} */
const char *orca_presets_create_filament(void *presets, const char *json);
/* {type, name} → {name, values{}}: any preset's settings as orca_presets_values gives the edited
 * one's (the selected preset as edited), for comparing presets side by side. */
const char *orca_presets_preset_values(void *presets, const char *json);

/* Desktop's calibration tests (its Calibration menu): {params{mode, start, end, step, …},
 * flow?{linear, pass, pattern}, assets, out} → {calib|null, notices[]}. Edits the edited presets
 * as desktop does and saves the test model as a 3MF at `out` (from the files in `assets`, laid out
 * as desktop's resources/calib); `calib` goes to orca_set_calib for its slices. */
const char *orca_presets_calib(void *presets, const char *json);
/* The VFA test dialog's check of its end speed against the filament's max volumetric speed:
 * {start, end, step, nozzle_based_resize} → {exceeds, max_vol_speed, default_lh, limit,
 * chosen_lh, min_lh, new_end} (see orca_calib.cpp). */
const char *orca_presets_calib_vfa(void *presets, const char *json);

/* {type} → [entry…]: every visible preset of the type, each with "compatible" for the selected
 * printer (desktop's "Show all presets (including incompatible)" when comparing presets). */
const char *orca_presets_all(void *presets, const char *json);

/* orca_presets_load into another handle (presets kept aside to compare with) without moving the
 * data folder the other handles save to. */
int orca_presets_load_aside(void *presets, const char *data_dir);

/* Support painting (desktop's GLGizmoFdmSupports) on an object of a loaded model:
 * {object, instances:[[16]…], supports?:[per model part]} (supports absent: as loaded). The painter
 * keeps its own copy of the meshes. NULL on failure (orca_last_error of the engine). */
void       *orca_paint_open(void *engine, const char *json);
void        orca_paint_close(void *painter);
/* {action:"move"|"down"|"drag"|"clear" (the fill's preview), button:"left"|"right", erase, tool:"circle"|"sphere"|"fill",
 *  rays:[[ox,oy,oz,dx,dy,dz]…] (world; the pointer, then back along its path to the last hit),
 *  camera:[3], radius, smart_fill_angle, overhang_limit, instances?} → {hit, point?, normal?, changed} */
const char *orca_paint_event(void *painter, const char *json);
/* The triangles to draw that changed since the last call (object coordinates), by block of the
 * original triangles: {ptr, full, blocks:[{part, block, counts:[enforcers, blockers, fill preview of
 * unpainted, enforcers, blockers]}]} as float counts from ptr, block after block. */
const char *orca_paint_render(void *painter);
/* Gap fill: {preview: area|null} and/or {apply: area}. */
int         orca_paint_gap(void *painter, const char *json);
void        orca_paint_reset(void *painter);
/* Other paint on the same object (undo): {supports:[per model part] | null (as loaded)}. */
int         orca_paint_set(void *painter, const char *json);
/* [[[triangle, "hex"]…] per model part]: desktop's 3MF form of the paint. */
const char *orca_paint_data(void *painter);

#ifdef __cplusplus
}
#endif
#endif
