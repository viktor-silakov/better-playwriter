# Better Playwriter Chrome extension

Better Playwriter connects the Chrome tabs you enable to a local relay for Playwright, CLI, and MCP clients.

## Install and connect

Use the Better Playwriter listing in Chrome Web Store once published. For a release ZIP or a local build, open `chrome://extensions`, enable **Developer mode**, and load the extracted folder or `extension/dist`. See the [project README](../README.md) for the CLI and build instructions.

Open a tab and click the extension icon to attach it. Start `better-playwriter session new` to bring up the relay. The icon turns green when the tab connects. Click it again to detach the tab.

## Permissions

- `debugger` connects to authorized tabs through Chrome DevTools Protocol.
- `scripting` injects the toolbar and locator picker where used.
- `tabGroups` and `contextMenus` group session tabs and add tab, locator, and sharing actions.
- `offscreen` and `clipboardWrite` support clipboard and audio actions initiated from the extension.
- `storage` stores extension state and profile labels.
- `identity` and `identity.email` help the local relay distinguish Chrome profiles.
- `webNavigation` tracks navigation and popups for enabled tabs.
- Host access allows the extension to operate on sites the user chooses.

With the default configuration, extension traffic goes to the local relay. If explicitly configured, Remote control shares enabled tabs through the configured tunnel after the user confirms. See [Security](../SECURITY.md) for what the recipient can access and how to stop sharing.
