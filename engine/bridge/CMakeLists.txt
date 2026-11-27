# The WebAssembly engine module: our C API (orca_engine.cpp) linked with libslic3r.
# Output: slicer-st.{mjs,wasm} or slicer-mt.{mjs,wasm} in ${CMAKE_BINARY_DIR}/dist.
# Emscripten link flags are documented inline; versions/behaviour verified against
# Emscripten 6.0.13 (src/settings.js). Revisit when bumping emsdk.

if(WASM_THREADS)
  set(_out slicer-mt)
else()
  set(_out slicer-st)
endif()

# The desktop's option toggle rules, copied verbatim out of Orca's GUI sources.
find_package(Python3 REQUIRED COMPONENTS Interpreter)
set(_gui_rules ${CMAKE_CURRENT_BINARY_DIR}/gui_rules_generated.cpp)
add_custom_command(OUTPUT ${_gui_rules}
  COMMAND Python3::Interpreter -I ${CMAKE_SOURCE_DIR}/scripts/extract-gui-rules.py ${ORCA_SOURCE_DIR} ${_gui_rules}
  DEPENDS ${CMAKE_SOURCE_DIR}/scripts/extract-gui-rules.py ${ORCA_SOURCE_DIR}/src/slic3r/GUI/ConfigManipulation.cpp
          ${ORCA_SOURCE_DIR}/src/slic3r/GUI/Tab.cpp
  COMMENT "Extracting the desktop option toggle rules")

add_executable(orca_engine orca_engine.cpp orca_presets.cpp orca_paint.cpp orca_calib.cpp new_delete.cpp gui_rules.cpp ${_gui_rules})
set_target_properties(orca_engine PROPERTIES OUTPUT_NAME ${_out} SUFFIX ".mjs"
                      RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/dist)
target_include_directories(orca_engine PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${ORCA_SOURCE_DIR}/src
                           ${ORCA_SOURCE_DIR}/deps_src)
target_link_libraries(orca_engine PRIVATE libslic3r libslic3r_cgal boost_libs nlohmann_json)

file(STRINGS ${CMAKE_SOURCE_DIR}/versions.env _sha_line REGEX "^ORCA_SHA=")
string(REPLACE "ORCA_SHA=" "" _orca_sha "${_sha_line}")
target_compile_definitions(orca_engine PRIVATE DOLPHIN_SLICER_ORCA_SHA="${_orca_sha}")

set(_exports
  _orca_api_version _orca_engine_info _orca_create _orca_destroy _orca_load_model
  _orca_set_config _orca_slice_start _orca_slice_poll _orca_cancel _orca_progress
  _orca_result _orca_last_error _orca_config_schema _orca_process_gcode _orca_export_preview
  _orca_add_model _orca_model_info _orca_export_meshes _orca_export_3mf _orca_set_layout _orca_arrange _orca_set_calib
  _orca_presets_create _orca_presets_destroy _orca_presets_load _orca_presets_list
  _orca_presets_select _orca_presets_select_loses _orca_presets_load_project _orca_presets_state _orca_presets_full_config _orca_presets_last_error
  _orca_presets_values _orca_presets_edit _orca_presets_reset _orca_presets_save _orca_presets_delete _orca_presets_import _orca_presets_templates _orca_presets_create_printer _orca_presets_linked _orca_presets_filament_list _orca_presets_create_filament _orca_presets_preset_values _orca_presets_all _orca_presets_load_aside _orca_presets_calib _orca_presets_calib_vfa
  _orca_paint_open _orca_paint_close _orca_paint_event _orca_paint_render _orca_paint_gap _orca_paint_reset _orca_paint_set _orca_paint_data
  _malloc _free)
list(JOIN _exports "," _exports_csv)

option(ORCA_ENGINE_FUNC_NAMES "Keep a wasm name section (readable stack traces)" ON)
if(ORCA_ENGINE_FUNC_NAMES)
  target_link_options(orca_engine PRIVATE --profiling-funcs)
endif()

target_link_options(orca_engine PRIVATE
  -O3
  -fwasm-exceptions -sSUPPORT_LONGJMP=wasm
  # ES module factory usable from a Web Worker and from Node (tests).
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createOrcaEngine
  -sENVIRONMENT=web,worker,node
  # Memory: grow on demand up to the wasm32 limit. ABORTING_MALLOC=0 makes allocation failure
  # surface as std::bad_alloc (→ ORCA_OOM) instead of an abort, so the host can report it.
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=128MB -sMAXIMUM_MEMORY=4GB -sABORTING_MALLOC=0
  # libslic3r recurses deeply on complex geometry (Clipper, Voronoi, Arachne).
  -sSTACK_SIZE=16MB
  # MEMFS for /in and /out; no preloaded data (the engine never reads Orca's resources/).
  -sFORCE_FILESYSTEM=1
  "-sEXPORTED_FUNCTIONS=${_exports_csv}"
  "-sEXPORTED_RUNTIME_METHODS=FS,ccall,cwrap,UTF8ToString,stringToNewUTF8,HEAPU8,wasmMemory"
)

if(WASM_THREADS)
  target_link_options(orca_engine PRIVATE
    -pthread
    # mimalloc scales across threads far better than dlmalloc (Orca's hot loops allocate a lot).
    -sMALLOC=mimalloc
    # Pre-spawn workers so oneTBB's first parallel_for does not wait on lazy worker creation.
    # The slice itself runs on a pthread (orca_slice_start), so the engine's JS thread stays
    # free and the pool can still grow on demand. navigator.hardwareConcurrency exists in
    # browsers and in Node >= 21.
    "-sPTHREAD_POOL_SIZE=((typeof navigator!=='undefined'&&navigator.hardwareConcurrency)||4)+2"
    -sDEFAULT_PTHREAD_STACK_SIZE=4MB
  )
endif()
