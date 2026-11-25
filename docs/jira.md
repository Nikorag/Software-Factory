# Using Jira instead of Linear

A profile uses **either** Linear **or** Jira (Settings → Integrations → Issue tracker), so one profile can be on Linear and another on Jira. Everything else (the pipeline, the Board, onboarding, the dashboard) works the same.

## Connecting (OAuth 2.0 / 3LO)

Jira Cloud is reached through an OAuth app that **you** create, so the factory only ever has the access you grant it.

1. Open the [Atlassian developer console](https://developer.atlassian.com/console/myapps/) and create an **OAuth 2.0 (3LO)** app.
2. **Permissions** → add the **Jira API** with the scopes `read:jira-work`, `write:jira-work` and `read:jira-user`. (The factory also asks for `offline_access`, which is what makes Atlassian issue a refresh token.)
3. **Authorization** → set the **Callback URL** to the one Settings shows, e.g. `http://127.0.0.1:4780/api/jira/oauth/callback`. Each profile runs on its own port, so each needs its own callback (a separate app per profile is simplest, and usually what you want anyway when the Jira sites differ).
4. Copy the **Client ID** and **Secret** into Settings and press **Save app**, then **Connect Jira** and approve access in the browser.

Where things are stored: the client ID is in the profile's `jira.yaml`; the client secret and the refresh token are in the macOS keychain (a service of its own per profile). Refresh tokens **rotate**: every refresh returns a new one and invalidates the old, so the factory saves the new one before doing anything else and never refreshes twice at once. If the refresh token is revoked, expires (Atlassian expires an unused one after 90 days) or the secret changes, the dashboard says to reconnect.

## Mapping statuses and labels

The factory **cannot create** Jira statuses: workflows belong to your admins. So (Settings → Integrations → *Map the factory's statuses and labels*):

| The factory's status | You choose |
|---|---|
| Ready for specification | the status automatic mode picks tickets up from (not needed in manual mode) |
| Specification review, In progress, Ready for review, Done, Blocked | an existing status for each (**required**) |
| Ready for development, Changes requested, Merging | optional; "(not used)" is fine |

A status left as "(not used)" is simply never set. Statuses can differ between Jira projects, so the page checks the mapping against every Jira project a factory project is linked to and lists any status that does not exist there.

**Transitions.** Jira moves a ticket by a workflow *transition*, and one must exist from the ticket's current status to the target. If your workflow has none, the factory records exactly which move was impossible ("no workflow transition to Done from In Progress"), leaves the ticket where it is and carries on with the job. Fix it by mapping a different status or adding the transition in Jira.

**Labels** are plain text in Jira and exist as soon as they are used, so the factory can add a label that does not exist yet. You still map them (opt-in, blocked, and the optional workflow labels) so you can reuse your own naming. Jira labels cannot contain spaces.

## Linking projects

In a project's editor, **Jira project** is the project key (e.g. `ENG`) and **Component** (optional) narrows it to one component, the same way a Linear project narrows a team. One repository per Jira project or component, as with Linear. A ticket with several components belongs to the project whose component it carries.

## What differs from Linear

- Comments are written as Atlassian Document Format and end with a small `Software Factory ref: <id>` line. That is how a retried write recognises a comment it already posted (Jira cannot take a client-chosen id).
- Pull requests are attached as a remote link (the same link is updated, never duplicated).
- The Board and its search work the same: `418` and `ENG-418` find a ticket by number; words search the summary.
- Jira cannot be set up by the factory (no "Create missing statuses" step), so there is a mapping step instead.

## Status

Built against Atlassian's documented OAuth and Jira Cloud REST v3 behaviour and tested against a stand-in server that models those endpoints (token rotation, transitions, JQL search via `/rest/api/3/search/jql`, ADF). It has **not** yet been run against a live Jira site, so expect to try it on a sandbox project first. Jira Cloud only; Jira Data Center / Server use different authentication and are not supported.
