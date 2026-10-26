# Surfaces the person sees

Every place where the person and a session meet, what each costs the person's attention, and what comes
back to Claude.

Attention cost, cheapest first: **0** pull only, nothing notifies · **1** one notification, read only ·
**2** a notification and one tap · **3** reading, editing or a flow · **4** pulls the person to a device
or another app.

## The map

| Surface | Cost | What comes back to Claude |
|---|---|---|
| Thread message (`post_message`) | 1 | The person's reply wakes the thread |
| Silent edit (`edit_message`) | 0 | Nothing |
| Progress checklist (`update_progress_checklist`) | 0 | Nothing; it feeds the Overview chip and the row's status |
| Reaction (`react` / `unreact`) | 0 to 1 | The person's reactions are readable with reactor names; not a reliable wake |
| Decision card (`request_decision`) | 2 | A tap wakes the thread; who tapped and when are recorded |
| Widget (`post_widget`) | 1 | Nothing |
| Message draft card (`message_compose_v1`) | 2 to 3 | A Send press note; then call `mark_draft_sent` |
| Editable draft (`writing_draft_v0`) | 3 | The person sends it back |
| Connector card (`suggest_connectors`) | 3 | The answer, as a message |
| Skill card (`propose_skills`) | 3 | Wakes at once with `outcome=shown` |
| Device link / Remote Control | 4 | Status wakes |
| Project chat (coordinator only) | 1 per post | Each person message wakes the coordinator |
| Overview: Threads panel, Custom view | 0 | Nothing |
| Library files | 0 | Nothing: a pull |
| Pinned artifacts (sidebar, account-wide) | 0 | Nothing |
| Artifacts | 1 to 3 | Only Send to Claude comments wake (about 1 s) |
| Claude Docs | 3 | Doc comments don't wake the creating thread |
| Phone push (`PushNotification`) | 4 | Nothing |

Zero-cost surfaces (checklist, Overview, pins, Library, silent edits) suit state. One-tap surfaces suit
decisions. A decision card is the cheapest **attributable** decision there is.

## Messages and attachments

- `post_message` takes Markdown. The app renders thread links `[Title](#cmsg_…)` and settings links
  `[Project settings](#project-settings/<section>)` (sections include `resources` for repositories and
  `environment` for the setup script). Connect GitHub is a plain link, `https://claude.ai/connect-github`.
- `attached_outputs` kinds: `file` (a path under `/mnt/project-files`, shown in the Library and on the
  thread's card), `link` (https URL and title), `frame` (an Artifact published in this project, shown as
  a live card). **A file that is not attached does not reach the person**: a Library path in the text is
  just text.
- Publishing an Artifact from a thread **attaches it to that thread automatically**. Attaching it again
  returns "already attached" and only moves its card to the new message.
- A Claude Doc reaches the Library only when a reply attaches it (kind `link`).
- `edit_message` silently replaces your own plain reply and sets `edited_at`. It refuses cards, widgets
  and checklists.
- Each checklist call replaces the whole checklist and is stored as a new `status` message, so earlier
  versions stay in the history and make `read_thread` noisy. The `workers` field maps named subagents to
  steps; `start_new` begins a fresh checklist.
- Every `post_message`, widget and card notifies the person. A checklist update and an edit notify nobody.

## Decision cards

- Limits: one question, 2 to 4 options, each with a `label` (≤40 bytes) and a `consequence` (≤200
  bytes); `context` ≤1200 bytes; a `recommended` index and a `reason` ≤200 bytes.
- A tap wakes the posting thread with the choice. `read_thread` shows `option_index`, `chosen_by` (the
  member id) and the time.
- `close_decision` records **Claude's own note** (`closed_by: "session"`), not a tap, and wakes nobody. A
  closed card proves nothing about the person's choice.
- A tap on a card the thread already withdrew is still accepted and recorded.
- A pending card files the thread under Waiting on you. A card wakes no **other** session: if another
  thread must know, message it.

## Widgets

- Families: `show_widget` (your own SVG or HTML; scripts run; external scripts only from esm.sh, cdnjs,
  jsdelivr, unpkg), plus card types for charts, comparisons, featured items, itineraries, link previews,
  options, places, product carousels, steps, recipes, `writing_draft_v0` and `message_compose_v1`.
- Widgets are **static snapshots** with no live data and no callback. Previews and notifications show
  only the `text` sentence. To change one, post a new one.
- A good use: a receipt that shows "here is what I understood" after reading back a form.

## Device, Remote Control and the person's browser

- `connect_device` posts a card that expires after 24 h and can be **allowed only from the Claude desktop
  app on that computer**. Web and phone can only decline it.
- `start_remote_control` runs a session on the person's device with their tools and credentials. It needs
  the id of the person's message in this thread, and an approval tap.
- Playwright in the cloud container **cannot open claude.ai** (a Cloudflare challenge) or private
  Artifacts. Claude in Chrome works in the person's own signed-in browser, but needs the person's own
  go-ahead; a card the thread closed itself does not count.
- An Artifact's content runs in a cross-origin iframe, so browser automation sees only the shell's
  controls. Read a page's state back through its database instead.

## Project chat, Overview and settings

- Message kinds in the chat: `onboarding`, `thread_started` (one per thread start; `standalone: true` for
  a routine's own thread), `message_routed` (the coordinator handed a person's message to a thread),
  activity rows (`pin_artifact`, `propose_project_setup`) and plain posts.
- A setup card (`propose_project_setup`) carries name, icon, colour, routines, up to 4 thread starts
  (each with `who`: claude or you, and `produces`: pr, doc or decision) and connectors. Confirming it
  creates the routines and threads.
- Only the person can edit the environment (setup script, network, environment variables). Changes to
  instructions, memory and the setup script apply to the **next** session, not running ones.
- The left sidebar holds Projects, Artifacts, Scheduled, Customize and pinned items. Pins are
  account-wide and scarce, so pin only when the person asks.
