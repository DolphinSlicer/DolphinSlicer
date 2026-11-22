// Stand-ins for the wxWidgets/Tab members used by the desktop's option toggle rules, so their
// bodies can be compiled verbatim (see engine/scripts/extract-gui-rules.py).
//
// Only what those bodies touch is provided. Toggles are recorded like the desktop's
// OptionStateRegistry: the last call for a key wins, and a reason is kept only while the option
// is unavailable. Widget-only work (combo box contents, dialogs, the overrides page checkboxes)
// becomes a no-op.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include <libslic3r/libslic3r.h>
#include <libslic3r/BeltBrim.hpp>
#include <libslic3r/Config.hpp>
#include <libslic3r/IMEXHelpers.hpp>
#include <libslic3r/Preset.hpp>
#include <libslic3r/PresetBundle.hpp>
#include <libslic3r/PrintConfig.hpp>

#include <boost/any.hpp>

#include <algorithm>
#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace Slic3r { namespace GUI {

// Untranslated text. The desktop translates at this point; the browser shows English for now.
struct wxString : std::string
{
    wxString() = default;
    wxString(const char *s) : std::string(s) {}
    wxString(const std::string &s) : std::string(s) {}
};
struct wxArrayString
{
    std::vector<wxString> items;
    void Add(const wxString &s) { items.push_back(s); }
};
struct wxWindow;

enum { wxICON_WARNING = 0x100, wxYES = 0x2, wxNO = 0x8, wxID_YES = 5103, wxID_NO = 5104 };

// The only dialog in these rules asks how to fix firmware retraction combined with a partial
// retract before wipe. The browser never edits as a side effect of reading states, and the
// result goes into a scratch copy anyway.
struct MessageDialog
{
    MessageDialog(wxWindow *, const wxString &, const wxString &, long) {}
    int ShowModal() { return wxID_NO; }
};

struct Field { virtual ~Field() = default; };
struct Choice : Field
{
    void set_values(const wxArrayString &) {}
    void set_value(const boost::any &, bool) {}
};

struct OptionStates
{
    std::map<std::string, std::string> disabled; // key -> reason
    std::map<std::string, std::string> hidden;   // key -> reason
    std::map<std::string, std::string> labels;   // key -> replacement label (untranslated)

    void enable(const std::string &key, bool on, const wxString &reason)
    {
        if (on) disabled.erase(key); else disabled[key] = reason;
    }
    void show(const std::string &key, bool on, const wxString &reason)
    {
        if (on) hidden.erase(key); else hidden[key] = reason;
    }
};

struct GUI_App { PresetBundle *preset_bundle = nullptr; };
GUI_App &wxGetApp();

struct DevPrinterConfigUtil
{
    static bool support_wrapping_detection(const std::string &type);
};

class ConfigManipulation
{
public:
    explicit ConfigManipulation(OptionStates &out) : m_out(out) {}

    void set_is_BBL_Printer(bool v) { is_BBL_Printer = v; }
    void toggle_print_fff_options(DynamicPrintConfig *config, int variant_index, const bool is_global_config = false);

private:
    OptionStates &m_out;
    bool          is_BBL_Printer = false;

    void toggle_field(const std::string &key, const bool toggle, int = -1, const wxString &reason = {}) { m_out.enable(key, toggle, reason); }
    void toggle_line(const std::string &key, const bool toggle, int = -1, const wxString &reason = {}) { m_out.show(key, toggle, reason); }
    void set_option_label(const std::string &key, const wxString &label, int = -1) { m_out.labels[key] = label; }
    // Same as the desktop: copy the changed keys into the config being toggled.
    void apply(DynamicPrintConfig *config, DynamicPrintConfig *new_config)
    {
        for (const std::string &key : config->diff(*new_config))
            config->set_key_value(key, new_config->option(key)->clone());
    }
};

// The members of Tab that TabFilament/TabPrinter::toggle_options use. The desktop runs
// toggle_options for the page on screen; the caller runs it once per page title instead.
class TabRules
{
public:
    struct Page
    {
        std::string name;
        const std::string &title() const { return name; }
        Field *get_field(const std::string &, int = -1) const { return nullptr; }
    };

    TabRules(OptionStates &out, PresetBundle &bundle, DynamicPrintConfig &config, PresetCollection &presets, int variant)
        : m_out(out), m_preset_bundle(&bundle), m_config(&config), m_presets(&presets), m_variant(variant)
    {
        if (const auto *nd = config.option<ConfigOptionFloats>("nozzle_diameter")) m_extruders_count = nd->size();
    }

    void set_page(const std::string &title) { m_page.name = title; }

protected:
    OptionStates       &m_out;
    PresetBundle       *m_preset_bundle;
    DynamicPrintConfig *m_config;
    PresetCollection   *m_presets;
    int                 m_variant;
    Page                m_page;
    Page               *m_active_page = &m_page;
    // Only used to show the belt frame tilt override, which is an Expert option itself; the app
    // applies the visibility mode to every option afterwards.
    ConfigOptionMode    m_mode = comDevelop;
    size_t              m_extruders_count = 1;
    struct ImexModes { void set_applicable(bool) {} };
    ImexModes          *m_imex_modes_ctrl = nullptr;

    void toggle_option(const std::string &key, bool toggle, int = -1, const wxString &reason = {}) { m_out.enable(key, toggle, reason); }
    void toggle_line(const std::string &key, bool toggle, int = -1, const wxString &reason = {}) { m_out.show(key, toggle, reason); }
    Field *get_field(const std::string &, int = -1) const { return nullptr; }
    void load_config(const DynamicPrintConfig &config) { m_config->apply(config); }
    void update_dirty() {}
    void reload_config() {}
    wxWindow *parent() const { return nullptr; }
    // The settings page edits the first extruder (orca_presets.cpp variant_index()).
    int get_current_active_extruder() const { return 0; }
    int extruder_variant_index(int) const { return m_variant; }
    unsigned int selected_variant_index() const { return unsigned(m_variant); }
    void update_input_shaper_menu(GCodeFlavor) {}
    // Checkbox wiring of the filament "Setting Overrides" page; the app shows overrides itself.
    void update_filament_overrides_page(const DynamicPrintConfig *) {}
};

class TabFilament : public TabRules
{
public:
    using TabRules::TabRules;
    void toggle_options();
};

class TabPrinter : public TabRules
{
public:
    using TabRules::TabRules;
    void toggle_options();
};

}} // namespace Slic3r::GUI

#ifndef L
#define L(s) s
#endif
#define _L(s) Slic3r::GUI::wxString(s)
#define _(s) Slic3r::GUI::wxString(s)
