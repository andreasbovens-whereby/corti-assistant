// Demo page: renders the server's session state and live updates (server-sent events).
// All text from the server goes in with textContent, never innerHTML.

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
};

// The token comes in the URL fragment (never sent to the server or in referrers),
// then lives in sessionStorage for this tab.
const fragmentToken = new URLSearchParams(location.hash.slice(1)).get("token");
if (fragmentToken) {
  sessionStorage.setItem("demoToken", fragmentToken);
  history.replaceState(null, "", location.pathname);
}
let token = sessionStorage.getItem("demoToken");

/** sessionId -> { info, transcript: Map<id, segment>, facts, note, errors, running, liveAt, lags: Map } */
const sessions = new Map();
let selectedId = null;
let userSelected = false;

function start() {
  if (!token) {
    $("token-gate").hidden = false;
    $("token-form").addEventListener("submit", (event) => {
      event.preventDefault();
      token = $("token-input").value.trim();
      sessionStorage.setItem("demoToken", token);
      $("token-gate").hidden = true;
      connect();
    });
    return;
  }
  connect();
}

function connect() {
  $("app").hidden = false;
  const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  events.addEventListener("open", () => setConnection("live", "Live"));
  events.addEventListener("error", () => {
    setConnection("offline", "Reconnecting…");
    // A wrong token closes the stream for good; check and ask again.
    fetch("/api/sessions", { headers: { authorization: `Bearer ${token}` } }).then((response) => {
      if (response.status === 401) {
        events.close();
        sessionStorage.removeItem("demoToken");
        token = null;
        $("app").hidden = true;
        start();
      }
    });
  });
  events.addEventListener("snapshot", (event) => {
    sessions.clear();
    for (const record of JSON.parse(event.data)) sessions.set(record.info.sessionId, fromRecord(record));
    render();
  });
  events.addEventListener("update", (event) => {
    applyUpdate(JSON.parse(event.data));
    render();
  });
}

function fromRecord(record) {
  return {
    info: record.info,
    transcript: new Map(record.transcript.map((segment) => [segment.id, segment])),
    facts: record.facts,
    note: record.note,
    errors: record.errors,
    running: record.running,
    liveAt: null,
    lags: new Map(),
  };
}

function sessionFor(id) {
  if (!sessions.has(id)) {
    sessions.set(id, fromRecord({ info: { sessionId: id, roomUrl: "", state: "starting" }, transcript: [], facts: [], note: undefined, errors: [], running: true }));
  }
  return sessions.get(id);
}

function applyUpdate(update) {
  const at = Date.parse(update.at);
  if (update.type === "session") {
    const session = sessionFor(update.info.sessionId);
    session.info = update.info;
    session.running = update.info.state !== "ended" && update.info.state !== "failed";
    if (update.info.state === "live") session.liveAt = at;
    // Follow new sessions automatically until the user picks one.
    if (!userSelected && update.info.state === "starting") selectedId = update.info.sessionId;
    return;
  }
  const session = sessionFor(update.sessionId);
  if (update.type === "transcript") {
    session.transcript.set(update.segment.id, update.segment);
    // Latency: from the end of the utterance (stream time) to its final transcript here.
    if (update.segment.final && session.liveAt) session.lags.set(update.segment.id, (at - session.liveAt) / 1000 - update.segment.end);
  }
  if (update.type === "facts") session.facts = update.facts;
  if (update.type === "note") session.note = update.note;
  if (update.type === "error") session.errors.push(update.message);
}

function setConnection(state, label) {
  const badge = $("connection");
  badge.dataset.state = state;
  badge.textContent = label;
}

function roomName(roomUrl) {
  try {
    return new URL(roomUrl).pathname.replace(/^\//, "") || roomUrl;
  } catch {
    return roomUrl || "Room";
  }
}

function render() {
  const list = [...sessions.values()].reverse(); // newest first
  if (!selectedId && list.length > 0) selectedId = list[0].info.sessionId;
  $("no-sessions").hidden = list.length > 0;
  $("session-list").replaceChildren(
    ...list.map((session) => {
      const button = el(
        "button",
        { type: "button", onclick: () => select(session.info.sessionId) },
        el("span", { className: "session-name", textContent: roomName(session.info.roomUrl) }),
        el("span", { className: "badge", textContent: session.info.state }),
      );
      button.querySelector(".badge").dataset.state = session.info.state;
      if (session.info.sessionId === selectedId) button.setAttribute("aria-current", "true");
      return el("li", {}, button);
    }),
  );
  renderSession(sessions.get(selectedId));
}

function select(id) {
  selectedId = id;
  userSelected = true;
  render();
}

function renderSession(session) {
  $("session").hidden = !session;
  if (!session) return;
  const { info } = session;
  $("session-title").textContent = roomName(info.roomUrl);
  $("session-meta").textContent = [info.state, info.reason, info.interactionId && `Corti interaction ${info.interactionId}`].filter(Boolean).join(" · ");
  $("end-button").hidden = !session.running;
  $("errors").replaceChildren(...session.errors.map((message) => el("li", { textContent: message })));

  const transcript = $("transcript");
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
  const segments = [...session.transcript.values()];
  transcript.replaceChildren(...segments.map((segment) => renderSegment(segment, session.lags.get(segment.id))));
  $("transcript-empty").hidden = segments.length > 0;
  if (nearBottom) transcript.scrollTop = transcript.scrollHeight;

  renderFacts(session.facts);
  renderNote(session.note);
}

function renderSegment(segment, lag) {
  const meta = el(
    "div",
    { className: "segment-meta" },
    el("span", { className: "segment-role", textContent: segment.role }),
    el("span", { textContent: clock(segment.start) }),
  );
  if (lag !== undefined) meta.append(el("span", { textContent: `${lag.toFixed(1)} s after speech`, title: "Latency from the end of the utterance to this page" }));
  if (!segment.final) meta.append(el("span", { textContent: "…" }));
  const item = el("li", { className: "segment" }, meta, el("div", { textContent: segment.text }));
  item.dataset.role = segment.role;
  item.dataset.final = String(segment.final);
  return item;
}

function renderFacts(facts) {
  const groups = new Map();
  for (const fact of facts) groups.set(fact.group, [...(groups.get(fact.group) ?? []), fact]);
  $("facts").replaceChildren(
    ...[...groups].map(([group, items]) =>
      el(
        "div",
        { className: "fact-group" },
        el("h4", { textContent: group.replaceAll("-", " ") }),
        el("ul", {}, ...items.map((fact) => el("li", { textContent: fact.text }))),
      ),
    ),
  );
  $("fact-count").textContent = facts.length ? `(${facts.length})` : "";
  $("facts-empty").hidden = facts.length > 0;
}

function renderNote(note) {
  $("note-empty").hidden = Boolean(note);
  if (!note) return $("note").replaceChildren();
  $("note").replaceChildren(
    el("div", { className: "draft-banner", textContent: note.label }),
    el("p", { className: "hint", textContent: `Template ${note.templateKey} · ${note.language} · generated from ${note.basedOn}` }),
    ...note.sections.map((section) =>
      el(
        "div",
        { className: "note-section" },
        el("h4", { textContent: section.heading }),
        section.text.trim() ? el("p", { textContent: section.text }) : el("p", { className: "empty", textContent: "Nothing documented." }),
      ),
    ),
  );
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

$("start-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = $("start-status");
  const button = event.submitter;
  button.disabled = true;
  status.textContent = "Inviting…";
  try {
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ roomUrl: $("room-input").value.trim() }),
    });
    const body = await response.json();
    const messages = {
      started: "The Assistant is joining. Someone must already be in the room.",
      "already-running": "The Assistant is already in that room.",
      "at-capacity": "Too many sessions are running; try again later.",
      "shutting-down": "The server is shutting down.",
    };
    status.textContent = response.ok ? messages[body.status] ?? body.status : body.error ?? "Couldn't invite the Assistant.";
    if (body.sessionId) select(body.sessionId);
  } catch {
    status.textContent = "Couldn't reach the server.";
  } finally {
    button.disabled = false;
  }
});

$("end-button").addEventListener("click", async () => {
  if (!selectedId || !confirm("End this session and generate the note now?")) return;
  await fetch(`/api/sessions/${encodeURIComponent(selectedId)}/end`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
});

start();
