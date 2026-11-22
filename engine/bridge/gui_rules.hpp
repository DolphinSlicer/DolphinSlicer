// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include <libslic3r/PresetBundle.hpp>
#include <nlohmann/json.hpp>

#include <string>

// Option states of the edited preset of one type ("print" | "filament" | "printer"), as the
// desktop settings tabs compute them:
// {"disabled": {key: reason}, "hidden": {key: reason}, "labels": {key: label}, "enums": {key: [values]}}
nlohmann::json orca_option_states(Slic3r::PresetBundle &bundle, const std::string &type, int variant_index);
