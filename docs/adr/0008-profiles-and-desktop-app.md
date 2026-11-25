# ADR 0008: Profiles are isolated instances, and the desktop app is a thin window

**Profiles.** A profile (e.g. "home", "work") is a complete, separate factory: its own config, database, clones, worktrees, logs, control token, port, Linear key (its own keychain entry *and* its own environment variable) and default GitHub account. Profiles run at the same time as separate processes. They share only a small registry (`~/.software-factory/profiles.json`) that lets each list the others and switch to them. The default profile is the original install, so nothing needs migrating.

*Why not one process serving every profile from one database?* It would mean a profile dimension on every table and every query, and shared in-process state, so one mistake could mix a work ticket into a personal repository. Separate processes make that impossible by construction and leave the engine untouched. The cost is one extra Node process per profile.

*Which `gh` account?* Each profile has a default GitHub login (`factory.githubAccount`), and a project can override it. The factory reads that account's token from `gh auth token --user <login>` for each call and never switches the machine's active `gh` login.

**The desktop app.** `software-factory` starts every profile's service as a detached background process and opens an Electron window onto the active profile, then returns, so the terminal is free. The window is deliberately thin: it only loads the loopback dashboard (`contextIsolation`, `sandbox`, no Node in the page, navigation limited to the registered profile origins, no permissions granted). The factory does not depend on it: closing the window leaves the services working, and `software-factory shutdown` stops them. It is launched by a command rather than packaged as a `.dmg`, so there is nothing to sign or notarise.

*Why a separate `shutdown` command?* `stop` already exists and means emergency stop (terminate running agents, pause).
