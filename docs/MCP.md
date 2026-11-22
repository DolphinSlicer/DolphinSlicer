# Connect an AI assistant

DolphinSlicer has an MCP server, so AI assistants such as Claude or ChatGPT can look at your
printer, filament and print settings, explain them and change them for you. Ask things like "Why
does my PETG string?" or "Make a copy of my print settings with 4 walls and gyroid infill."

The assistant sees what DolphinSlicer keeps in your Google Drive, so turn on **Google Drive sync**
in DolphinSlicer first (Preferences).

## Connect

Add a custom connector (or MCP server) with this address:

```
https://dolphinslicer.app/mcp
```

- **Claude:** Settings → Connectors → Add custom connector.
- **ChatGPT:** add it as a connector (needs developer mode).
- **Claude Code:** `claude mcp add --transport http dolphinslicer https://dolphinslicer.app/mcp`
- **Other apps:** any app that supports remote MCP servers with sign-in.

The app opens a DolphinSlicer page that names it. Click **Allow**, then sign in with the Google
account you use for Drive sync.

## What the assistant can do

| Tool | What it does |
| --- | --- |
| `get_setup` | Your selected printer, filament and print settings, your printer and filament list, your own presets |
| `get_preset` | All settings of a preset, and what your own presets change |
| `compare_presets` | The settings that differ between two presets |
| `explain_setting` | What a setting does, its unit, limits and options |
| `find_profiles` | OrcaSlicer's built-in printer, filament and print profiles |
| `save_preset` | Changes one of your presets, or makes a new one |

A saved preset shows up in DolphinSlicer at its next sync: switch back to its tab or reload it,
then select the preset. Assistants usually ask before saving; you can also tell them to.

## Disconnect

Remove the connector in your assistant. To end access for every assistant at once, remove
DolphinSlicer in your [Google account](https://myaccount.google.com/permissions); this signs out
Drive sync too, so sign in again in DolphinSlicer afterwards.

## Privacy

The server passes your settings between your Drive and the assistant and stores nothing. What the
assistant receives is handled by its provider. See the [privacy policy](https://dolphinslicer.app/privacy).
