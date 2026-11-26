# Tracker connections: one tracker per project

A profile is no longer tied to one issue tracker. It has any number of **tracker connections**, and each **project** says which one its tickets live in. So one profile can have a work Jira, a client's Jira, two Linear workspaces and a GitHub repository, all running side by side.

## Concepts

- A **connection** is an instance of Linear, Jira or GitHub Issues, with its own credentials and its own status and label names. It has an **id** (`work-jira`) and a display name.
- The three **built-in** connections always exist, with the ids `linear`, `jira` and `github`. They are configured exactly as before (`linear.yaml`, `jira.yaml`, `github-issues.yaml`), so existing setups keep working untouched.
- Further connections are named in **`trackers.yaml`**. Their ids are lowercase letters, numbers and hyphens and cannot reuse a built-in id.
- The profile has a **default** connection (`factory.yaml`: `tracker: <id>`, default `linear`). A project uses it unless it names its own with `tracker: <id>` in `projects.yaml`.

```yaml
# trackers.yaml
connections:
  work-jira:   { kind: jira,   label: Work Jira,   keychainService: software-factory-jira-work-jira }
  client-jira: { kind: jira,   label: Client Jira, keychainService: software-factory-jira-client-jira }
  home-linear: { kind: linear, label: Home,        apiKeyEnv: LINEAR_API_KEY_HOME_LINEAR, keychainService: software-factory-linear-home-linear }
  oss:         { kind: github, label: OSS issues,  account: some-bot, statusPrefix: "status: " }
```

```yaml
# projects.yaml
projects:
  - { id: web, tracker: work-jira, linear: { teamKey: WEB } }   # `linear:` is the tracker binding whatever the kind: team / Jira project / owner/repo
  - { id: api, linear: { teamKey: ENG } }                       # no tracker: follows the profile default
```

Add, rename and remove connections, set the default, and choose each project's connection in **Settings**: Integrations → Issue tracker, and Projects → Issue tracker. You normally never edit `trackers.yaml` by hand.

## Credentials never mix

Each connection has its own secrets: a Linear connection its own API key (environment variable and keychain service), a Jira connection its own OAuth app, client secret, rotating refresh token and site, a GitHub connection its own `gh` account (or the profile's). When you add a connection the factory gives it a keychain service and key variable derived from its id; loading refuses two connections of the same kind that point at the same ones. Removing a connection leaves its keychain entries alone.

The Jira OAuth callback URL is the same for every Jira connection (`/api/jira/oauth/callback`): the one-use `state` of each sign-in says which connection it is for.

## What is per project

Everything that talks to a tracker asks for the project's own connection and uses *that connection's* names:

- **Discovery** polls each connection for its own projects (an unmapped Jira pickup status, or one connection being down, affects only the projects on it).
- **The outbox** sends each job's status, label, comment and PR-link writes to the connection of the job's project, with its status names.
- **Intake, spec and implementation stages** read the live ticket from that connection.
- **The Board** shows every project's tickets, asking each connection for its own; a connection that is down shows a warning instead of hiding the rest. Starting a ticket reads it from the connection of the project it was listed under.
- **Health and the doctor** check every connection a project uses.

## Changing the default

Only projects that follow the default are affected, so only their active jobs block the switch. Projects that name their own tracker keep it.

## Limits

- A ticket's binding is `connection + team`: two projects may not bind the same team (and milestone/component) in the *same* connection, but the same team key in two connections is fine.
- Switching a project to another connection means re-linking its team or repository (the ids differ between trackers).
