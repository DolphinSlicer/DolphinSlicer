// Shared between the bridge's sources: the engine's model and error reporting (orca_engine.cpp),
// painted facets in desktop's 3MF form (orca_paint.cpp), and the presets (orca_presets.cpp).
// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include <libslic3r/Model.hpp>
#include <libslic3r/TriangleSelector.hpp>
#include <nlohmann/json.hpp>

#include <string>

namespace Slic3r { class PresetBundle; struct Calib_Params; }

namespace orca_bridge {

// The presets handle's bundle (null before orca_presets_load), its error and its returned text.
Slic3r::PresetBundle *presets_bundle(void *presets);
int presets_fail(void *presets, int code, const std::string &message, const std::string &detail = {});
const char *presets_ret(void *presets, std::string s);

// Calibration parameters as orca_presets_calib returns them (orca_calib.cpp); false: not those.
bool calib_params_from_json(const nlohmann::json &j, Slic3r::Calib_Params &params);

Slic3r::Model *engine_model(void *engine);
int engine_fail(void *engine, int code, const std::string &message, const std::string &detail = {});

// A volume's painted facets as desktop's 3MF writes them ("paint_supports"): [[triangle, "hex"], …]
// for the triangles that are painted or split, in ascending order.
nlohmann::json facets_to_json(const Slic3r::TriangleSelector::TriangleSplittingData &data);
// The reverse; false when the data doesn't fit a mesh of `triangles` (null: nothing painted).
bool facets_from_json(Slic3r::TriangleSelector::TriangleSplittingData &data, const nlohmann::json &j, size_t triangles);
// Set a volume's painted supports from that form (checked with facets_from_json first).
void set_volume_facets(Slic3r::FacetsAnnotation &facets, const nlohmann::json &j);

} // namespace orca_bridge
