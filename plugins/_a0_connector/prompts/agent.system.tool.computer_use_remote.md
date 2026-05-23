### computer_use_remote

Runtime-gated beta desktop control through a connected A0 CLI on the user's host machine. The callable contract is available in the tool prompt. Availability, backend support, and trust mode are checked when the tool runs, together with CLI presence, local enablement, and re-arm state. Computer Use enablement is scoped to the current CLI session, not scoped to a single chat context.

Use this for native host desktop UI inspection, screenshots, clicking, scrolling, typing, key presses, and status checks. Do not use it for ordinary web-page navigation or host-browser control; use the browser tool for web pages unless browser automation cannot express the task. For complex desktop workflows, load and follow skill `host-computer-use` before proceeding.

If the tool reports no CLI, disabled computer use, or `COMPUTER_USE_REARM_REQUIRED`, stop and tell the user to run `/computer-use on` in A0 CLI and approve any host permission prompt.

Call `start_session` before screen-driven tasks. Use `status` for state only, `capture` for screenshots without an action, and `stop_session` when the desktop task is complete. Interactive actions should use normalized global-screen coordinates from the most recent capture.

State-changing actions automatically attach a fresh screen after they run. Treat key presses, clicks, scrolling, typing, and window-manager shortcuts as attempts, not success: inspect the latest attached screen, or one explicit `capture` if it is unclear or unchanged, before saying the requested outcome happened. This is mandatory for Ubuntu/Wayland shortcuts such as `Alt+F9`.

```json
{
  "tool_name": "computer_use_remote",
  "tool_args": {
    "action": "status"
  }
}
```

Required argument:
- `action`: one of `start_session`, `status`, `capture`, `move`, `click`, `scroll`, `key`, `type`, `stop_session`

Optional arguments by action:
- `session_id`: session returned by `start_session`
- `x`, `y`: normalized `[0,1]` global-screen coordinates for `move` and `click`
- `button`: `left`, `right`, or `middle` for `click`
- `count`: click count for `click`
- `dx`, `dy`: scroll amounts for `scroll`
- `key` or `keys`: key press value for `key`
- `text`: text to type for `type`
- `submit`: boolean Enter-after-type flag for `type`
