"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Slider } from "@heroui/react";
import { play } from "cuelume";
import { DitherConfetti } from "@/components/DitherConfetti";
import { Mascot } from "@/components/Mascot";
import { VendorMark } from "@/components/brands";
import {
  Panel,
  PixelButton,
  Badge,
  Field,
  TextInput,
  TextArea,
  Segmented,
  Select,
  SuccessCheck,
  ResizeBox,
  Notice,
  PageLoading,
} from "@/components/ui";
import { MASCOT_ORDER, MASCOTS, type MascotState } from "@/lib/mascot";
import { SkillBrowser } from "@/components/SkillBrowser";
import { AgentCanvas } from "@/components/canvas/AgentCanvas";
import {
  TARGETS,
  agentRepos,
  modelsFor,
  type Agent,
  type AgentTarget,
  type PickedSkill,
} from "@/lib/types";
import {
  addNode,
  agentFromGraph,
  componentNodeFor,
  componentPicksFor,
  componentsOf,
  duplicateMany,
  graphFromAgent,
  graphIssues,
  isAgentKind,
  newSubagent,
  nodeById,
  nodeRef,
  normalizeGraph,
  orchestratorOf,
  pickToNode,
  removeNode,
  slotUnder,
  subagentsOf,
  updateNode,
  type AgentGraph,
  type GraphNode,
} from "@/lib/graph";
import { useGraphHistory } from "@/lib/use-graph-history";
import { saveAgent, useAgents, useAgentsLoading, useStoreError } from "@/lib/store";
import { usePlan } from "@/lib/use-plan";
import { PLANS, atLimit, formatUsage } from "@/lib/plans";
import { UsageChip } from "@/components/PlanUsage";
import {
  exportAgent,
  installCommand,
  newProjectCommand,
  skillsManifest,
  agentSpecJson,
  mcpServeCommand,
} from "@/lib/export";
import { docPack, formatTokens, packTokens, type DocFile } from "@/lib/docs";
import { zipBlob } from "@/lib/zip";
import { planAllows, cheapestPlanWith } from "@/lib/access";
import { copyText } from "@/lib/copy";
import { decodeAgent, encodeAgent, shareUrl } from "@/lib/share";
import {
  AngleLeftIcon,
  ArrowRightIcon,
  DownloadIcon,
  LockIcon,
  PaperclipIcon,
  PlusIcon,
  SaveIcon,
  ShareIcon,
} from "@/components/icons";

// The tick is always in the DOM — it just sits at opacity 0 until `done`, so
// the button keeps one width and never reflows as the check draws itself in.
// The paperclip and the check are the same size, so swapping them on success
// keeps that width promise.
function CopyLabel({ done }: { done: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      {done ? <SuccessCheck shown size={10} /> : <PaperclipIcon size={10} />}
      {done ? "Copied" : "Copy"}
    </span>
  );
}

function newAgent(): Agent {
  const base: Agent = {
    id: `agent-${Date.now().toString(36)}`,
    name: "Untitled Agent",
    role: "general assistant",
    systemPrompt: "You are a focused, pixel-precise engineering agent.",
    target: "claude-code",
    model: "claude-opus-5",
    temperature: 0.7,
    skills: [],
    mascot: "working",
    accent: "#f95c4b",
    createdAt: Date.now(),
  };
  // Every agent in the composer has a graph from the first render. Making it
  // optional in the type is about what is *stored*; making it optional in here
  // would mean every canvas handler has to cope with there being no canvas.
  return { ...base, graph: graphFromAgent(base) };
}

function Builder() {
  const params = useSearchParams();
  const router = useRouter();
  const agents = useAgents();
  const agentsLoading = useAgentsLoading();
  const editId = params.get("id");

  const [agent, setAgent] = useState<Agent>(newAgent);
  const [saved, setSaved] = useState(false);
  const [confettiToken, setConfettiToken] = useState(0);
  const storeError = useStoreError();
  // preview state driven by which field is active
  const [previewState, setPreviewState] = useState<MascotState>("working");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [fromShare, setFromShare] = useState(false);
  // Multi-select: the canvas can move, duplicate and delete several nodes at
  // once. The first entry is the one the inspector below the canvas edits.
  const [selection, setSelection] = useState<string[]>([]);
  const selectedId = selection[0] ?? null;
  const selectOne = useCallback((id: string | null) => setSelection(id ? [id] : []), []);
  // Frozen graph: no moving, wiring, adding or deleting. Held here rather than
  // inside the canvas so this page's own buttons grey out with it.
  const [locked, setLocked] = useState(false);

  // ---- graph ---------------------------------------------------------------

  // `graph` is never absent here — newAgent, the store and the share decoder
  // all normalize one in — but the field is optional on the record, so this is
  // the single place that resolves it instead of a `!` at every use.
  const graph: AgentGraph = agent.graph ?? graphFromAgent(agent);
  const root = orchestratorOf(graph);

  // The `Agent` record owns the graph, so the undo stack cannot: it snapshots
  // either side of every canvas edit and hands the winner back through here.
  // agentFromGraph is the only writer of name/prompt/model/skills — it mirrors
  // the orchestrator node onto the record so the exports, the preview card and
  // the share payload never read a stale copy of the same fields.
  const applyGraph = useCallback((next: AgentGraph) => {
    setAgent((a) => agentFromGraph(a, next));
    setSaved(false);
  }, []);
  const history = useGraphHistory(graph, applyGraph);
  const setGraph = history.commit;

  // ---- loading -------------------------------------------------------------

  useEffect(() => {
    if (!editId) return;
    const found = agents.find((a) => a.id === editId);
    // A stored agent may predate the canvas; normalizeGraph is what
    // guarantees the rest of this component always has one to edit.
    // Not found is not always an error — the account's agents may still be
    // loading — so the "no such agent" notice below waits for that to settle
    // rather than firing on the first render.
    if (!found) return;
    setAgent({ ...found, graph: normalizeGraph(found.graph, found) });
    // A different agent is a different document. Its undo stack is not this
    // one's, and ⌘Z must not walk backwards into the agent you just left.
    history.reset();
    setSelection([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId, agents.length]);

  // A `?s=` payload is a shared agent. It loses to `?id=`, which names an
  // agent the user already owns — opening your own agent should never be
  // hijacked by a stale query string.
  const shared = params.get("s");
  useEffect(() => {
    if (editId || !shared) return;
    const decoded = decodeAgent(shared);
    if (!decoded) return;
    setAgent(decoded);
    setFromShare(true);
    setPreviewState("wizard");
    history.reset();
    setSelection([]);
    // Once the spec is in state the payload is noise in the address bar, and
    // leaving it there would re-apply on every back-navigation.
    router.replace("/build");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared, editId]);

  /**
   * Which agent node the inspector and the component browser are pointed at.
   * Selecting a component node keeps the panel on that component's owner, so
   * clicking a skill to inspect it does not silently retarget where the next
   * pick will land.
   */
  const activeAgentId = useMemo(() => {
    const selected = nodeById(graph, selectedId);
    if (selected && isAgentKind(selected.kind)) return selected.id;
    if (selected) {
      const owner = graph.edges.find((e) => e.to === selected.id)?.from;
      const ownerNode = nodeById(graph, owner ?? null);
      if (ownerNode && isAgentKind(ownerNode.kind)) return ownerNode.id;
    }
    return root?.id ?? "";
  }, [graph, selectedId, root?.id]);

  const activeNode = nodeById(graph, activeAgentId);
  const editingRoot = activeNode?.kind === "orchestrator";

  /** Edit whichever agent node is active — orchestrator or specialist. */
  const patchActive = (patch: Partial<GraphNode>) => {
    if (!activeAgentId) return;
    // Tagged by field so a typed-out name is one undo step, not one per key.
    setGraph(updateNode(graph, activeAgentId, patch), `patch:${activeAgentId}:${Object.keys(patch).join(",")}`);
  };

  /**
   * A new specialist. `at` comes from a double-click or the canvas' "add
   * subagent here", and puts the node where the pointer was rather than in the
   * next free slot — the point of asking for one *there*. `ownerId` comes from
   * the menu's "under this", which names its owner outright because the
   * selection it would otherwise be read from has not landed yet.
   */
  const addSubagent = (at?: { x: number; y: number }, ownerId?: string) => {
    const owner = (ownerId ? nodeById(graph, ownerId) : null) ?? activeNode ?? root;
    if (!owner || locked) return;
    const slot = at ?? slotUnder(graph, owner.id);
    // The graph goes in so the new specialist takes the next mascot in the
    // rotation rather than the same one its siblings already wear.
    const node = newSubagent(owner, Math.round(slot.x), Math.round(slot.y), graph);
    setGraph(addNode(graph, node, owner.id));
    setSelection([node.id]);
    setPreviewState("wizard");
  };

  /**
   * "Edit this one's fields", from the canvas menu. The canvas can rename a
   * node in place but not write its prompt, so it hands the node over and this
   * takes the page the rest of the way: select it, bring the panel into view,
   * put the caret in the first field.
   */
  const editNodeFields = (id: string) => {
    setSelection([id]);
    // Next frame: the panel below re-renders around the new selection, and
    // scrolling to where the old one was is a jump to the wrong place.
    requestAnimationFrame(() => {
      const el = document.getElementById("node-name") as HTMLInputElement | null;
      if (!el) return;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
      // The scroll above owns the movement; focus must not fight it with a
      // second, instant one.
      el.focus({ preventScroll: true });
    });
  };

  const deleteSelected = () => {
    if (selection.length === 0 || locked) return;
    let next = graph;
    for (const id of selection) next = removeNode(next, id);
    if (next === graph) return;
    setGraph(next);
    setSelection([]);
  };

  const duplicateSelected = () => {
    if (locked) return;
    const result = duplicateMany(graph, selection);
    if (result.graph === graph) return;
    setGraph(result.graph);
    setSelection(result.ids);
    setPreviewState("wizard");
  };

  // A pick toggles against the *active agent node*, not the agent as a whole:
  // the point of the canvas is that a specialist carries only its own tools.
  const toggleSkill = (s: PickedSkill) => {
    // A pick is a node on the canvas, so the lock has to cover it too —
    // otherwise "locked" would quietly mean "locked except this one door".
    if (!activeAgentId || locked) return;
    const existing = componentNodeFor(graph, activeAgentId, s.id);
    if (existing) {
      setGraph(removeNode(graph, existing.id));
    } else {
      const slot = slotUnder(graph, activeAgentId);
      setGraph(addNode(graph, pickToNode(s, slot.x, slot.y), activeAgentId));
    }
    setPreviewState("wizard");
  };

  const activePicks = activeAgentId ? componentPicksFor(graph, activeAgentId) : [];
  const activeComponents = activeAgentId ? componentsOf(graph, activeAgentId) : [];
  const issues = useMemo(() => graphIssues(graph), [graph]);

  // The orchestrator is the one node that cannot be duplicated or deleted, so
  // a selection of only it leaves both buttons with nothing to do.
  const canEditSelection =
    !locked && selection.some((id) => nodeById(graph, id)?.kind !== "orchestrator");

  // Only once the account's agents have actually arrived: during the fetch the
  // list is legitimately empty and every `?id=` would look missing.
  const missingAgent =
    !!editId && !agentsLoading && !agents.some((a) => a.id === editId);

  const output = useMemo(() => exportAgent(agent), [agent]);
  const install = useMemo(() => installCommand(agent), [agent]);
  const newProj = useMemo(() => newProjectCommand(agent), [agent]);
  const repos = agentRepos(agent);

  // The file the target tool loads on every turn — what the context pack tells
  // the reader to keep short. The MCP target exports an `mcp.json`, which no
  // model reads as instructions, so the pack names the file that tool's own
  // client would put alongside it instead.
  const entryFile = agent.target === "generic-mcp" ? "AGENTS.md" : output.filename;
  const docs = useMemo(() => docPack(agent, entryFile), [agent, entryFile]);

  // ---- AI-filled context docs -----------------------------------------------
  //
  // The scaffolds above render for free, no API call, no plan check. Filling
  // one in is a Foundry call, so it rides the same gate the hosted drafts do —
  // `aiDocs` holds what came back, keyed by path, and wins over the static
  // scaffold at that path wherever one exists.
  const { plan: planId } = usePlan();
  const aiDocsAllowed = planAllows(planId, "ai-docs");
  const [aiDocs, setAiDocs] = useState<Record<string, DocFile>>({});
  const [generatingDoc, setGeneratingDoc] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);

  // A different agent loading in — not an edit to this one — makes any draft
  // stale for content it never saw, so it goes with it. `agent.id` only
  // changes on a load, never on a field edit.
  useEffect(() => {
    setAiDocs({});
    setDocError(null);
  }, [agent.id]);

  const displayDocs = useMemo(() => docs.map((d) => aiDocs[d.path] ?? d), [docs, aiDocs]);
  const docsTokens = useMemo(() => packTokens(displayDocs), [displayDocs]);

  const generateDoc = async (path: string) => {
    setGeneratingDoc(path);
    setDocError(null);
    try {
      const res = await fetch("/api/docs/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, agent }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "generation failed");
      setAiDocs((prev) => ({ ...prev, [path]: data.doc as DocFile }));
      setPreviewState("rocket");
      setTimeout(() => setPreviewState(agent.mascot), 900);
    } catch (e) {
      setDocError(e instanceof Error ? e.message : "generation failed");
      play("error");
    } finally {
      setGeneratingDoc(null);
    }
  };

  // ---- the plan's agent cap ------------------------------------------------
  //
  // The cap binds in the database (a before-insert trigger), and the store
  // rolls a refused save back — but the user only found out afterwards, from
  // an error where a saved agent should have been. This is the same rule, read
  // ahead of the press: an *existing* agent can always be saved again, because
  // an update is not a new row, so only a first save is ever blocked.
  // (`planId` itself comes from usePlan() above, next to the other reader.)
  const agentCap = planId ? PLANS[planId].agents : null;
  const isNewAgent = !agents.some((a) => a.id === agent.id);
  const capReached = isNewAgent && atLimit(agents.length, agentCap);

  const doSave = () => {
    if (capReached) return;
    setPreviewState("cooking");
    saveAgent(agent);
    setSaved(true);
    play("success");
    // A counter rather than a boolean: saving twice in a row has to re-fire,
    // and a flag that is already true is not a state change.
    setConfettiToken((n) => n + 1);
    setTimeout(() => setPreviewState(agent.mascot), 900);
  };

  const copy = () => doCopy(output.content, "output");

  // One shared handler for every Copy button; only the winning key turns
  // green, and only when the text really landed on the clipboard.
  const doCopy = async (text: string, key: string) => {
    if (!(await copyText(text))) return;
    setCopiedKey(key);
    setPreviewState("rocket");
    setTimeout(() => setCopiedKey(null), 1600);
    setTimeout(() => setPreviewState(agent.mascot), 900);
  };

  const downloadBlob = (filename: string, blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setPreviewState("rocket");
    setTimeout(() => setPreviewState(agent.mascot), 900);
  };
  const download = (filename: string, text: string) =>
    downloadBlob(filename, new Blob([text], { type: "application/json" }));

  const downloadManifest = () => download("creagent.skills.json", skillsManifest(agent));
  const downloadAgent = () => download("creagent.agent.json", agentSpecJson(agent));

  // The pack is a folder, so it goes out as a zip — a browser download cannot
  // carry `docs/` in a filename, and eight flat files are the user's problem
  // to reassemble.
  const downloadDocs = () =>
    downloadBlob(
      "agent-docs.zip",
      zipBlob(displayDocs.map((d) => ({ path: d.path, content: d.content }))),
    );

  // Built on the client so the link carries whatever origin the user is
  // actually on — localhost while developing, the deploy URL in production.
  const copyShareLink = async () => {
    const url = shareUrl(agent, window.location.origin);
    if (!url) {
      setPreviewState("sherlock");
      return;
    }
    await doCopy(url, "share");
  };
  const shareable = useMemo(() => encodeAgent(agent) !== null, [agent]);

  return (
    <div>
      <DitherConfetti token={confettiToken} />
      <div className="mx-auto max-w-6xl px-5 py-8">
        {/* Stacks below `sm`: the Silkscreen title and both buttons cannot
            share a 375px row without colliding. */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
          <div>
            <h1 className="font-pixel text-xs sm:text-sm mb-1">AGENT_COMPOSER</h1>          </div>
          {/* Wraps because both buttons are `whitespace-nowrap`: they need more
              room than a 320px viewport has once the page gutters are taken
              out, which pushed "Save agent" off-screen and gave the whole page
              a horizontal scrollbar. */}
          <div className="flex flex-wrap items-center gap-2">
            <UsageChip kind="agents" />
            <PixelButton
              variant="ghost"
              onClick={copyShareLink}
              disabled={!shareable}
              title={
                shareable
                  ? "Copy a link that rebuilds this agent"
                  : "System prompt is too long to fit in a link — export the file instead"
              }
            >
              <span className="inline-flex items-center gap-1.5">
                {copiedKey === "share" ? <SuccessCheck shown size={12} /> : <ShareIcon size={12} />}
                {copiedKey === "share" ? "Link copied" : "Share"}
              </span>
            </PixelButton>
            <PixelButton
              variant="coral"
              onClick={doSave}
              disabled={capReached}
              title={
                capReached
                  ? `You're at ${formatUsage(agents.length, agentCap)} saved agents — delete one or upgrade`
                  : "Save this agent to your account"
              }
            >
              <span className="inline-flex items-center gap-1.5">
                {saved ? <SuccessCheck shown size={12} /> : <SaveIcon size={12} />}
                {saved ? "Saved" : "Save agent"}
              </span>
            </PixelButton>
          </div>
        </div>

        {/* `?id=` naming an agent this account does not have — a deleted one, a
            bookmark from another account, a hand-typed id. The composer used to
            fall through to a blank "Untitled Agent" without a word, so the next
            Save quietly created a second agent instead of editing the one the
            link pointed at. */}
        {missingAgent && (
          <Notice tone="info" className="mb-5">
            No agent <code className="text-coral-text">{editId}</code> in this
            account — it may have been deleted, or belong to another one. What
            is open below is a new, unsaved agent.
          </Notice>
        )}

        {/* Nothing is stored yet — a shared agent lives in this tab until the
            recipient saves it, and saying so avoids them closing it. */}
        {fromShare && (
          <Notice tone="info" className="mb-5">
            Opened from a shared link. Edit anything you like — it is not saved
            to your account until you press <strong>Save agent</strong>.
          </Notice>
        )}

        {/* Said before the press rather than after it — everything on this page
            still works, the agent just has nowhere to go until a slot frees up,
            and exporting or sharing it does not need one. */}
        {capReached && (
          <Notice
            className="mb-5"
            action={
              <Link href="/pricing">
                <PixelButton variant="coral" className="!px-3 !py-1 !text-[9px]">
                  <span className="inline-flex items-center gap-1">
                    See plans
                    <ArrowRightIcon size={10} />
                  </span>
                </PixelButton>
              </Link>
            }
          >
            {formatUsage(agents.length, agentCap)} saved agents on{" "}
            {planId ? PLANS[planId].label : "your plan"} — delete one from the
            home page to free a slot, or upgrade. Export and share still work.
          </Notice>
        )}

        {/* A rejected write has already been rolled back in the store, so this
            is the only thing telling the user their save did not stick. */}
        {storeError && <Notice className="mb-5">{storeError}</Notice>}

        {/* min-w-0 on both columns: grid items default to min-width:auto, so the
            export <pre> and the nowrap install <code> below size the track to
            their own max-content and push the whole page into horizontal scroll
            on phones. */}
        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          {/* FORM */}
          <div className="space-y-5 min-w-0">
            <AgentCanvas
              graph={graph}
              onChange={setGraph}
              selection={selection}
              onSelectionChange={setSelection}
              onAddSubagent={addSubagent}
              onEditNode={editNodeFields}
              locked={locked}
              onLockedChange={setLocked}
              history={history}
              className="h-[520px]"
              toolbar={
                <>
                  <PixelButton
                    variant="ghost"
                    onClick={() => addSubagent()}
                    disabled={locked}
                    className="!px-2 !py-0.5 !text-[9px]"
                    title={
                      locked
                        ? "Canvas is locked"
                        : `Add a specialist under ${activeNode?.name ?? "the orchestrator"}`
                    }
                  >
                    <span className="inline-flex items-center gap-1">
                      <PlusIcon size={10} />
                      subagent
                    </span>
                  </PixelButton>
                  <PixelButton
                    variant="ghost"
                    onClick={duplicateSelected}
                    disabled={!canEditSelection}
                    className="!px-2 !py-0.5 !text-[9px]"
                    title="Duplicate the selection, components and all (⌘D)"
                  >
                    duplicate
                  </PixelButton>
                  <PixelButton
                    variant="ghost"
                    onClick={deleteSelected}
                    disabled={!canEditSelection}
                    className="!px-2 !py-0.5 !text-[9px]"
                    title="Delete the selected nodes and everything under them"
                  >
                    delete
                  </PixelButton>
                </>
              }
            />

            {/* Structural problems, not validation errors: the agent still
                exports, it just would not do what the canvas shows. */}
            {issues.length > 0 && (
              <Panel className="p-3">
                <div className="font-pixel text-[9px] uppercase text-muted mb-1.5">
                  {issues.length} thing{issues.length === 1 ? "" : "s"} to wire up
                </div>
                <ul className="space-y-1">
                  {/* Indexed: two specialists both left unnamed produce the
                      same sentence, and the message is the only identity a
                      plain string key would have. */}
                  {issues.map((issue, i) => (
                    <li key={`${i}-${issue}`} className="font-mono text-[10px] text-ink-soft leading-snug">
                      — {issue}
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            <Panel className="p-5 space-y-4">
              {/* Which node the panel is pointed at. Without this the same
                  fields silently mean two different things depending on what
                  is selected on the canvas. */}
              <div className="flex items-center justify-between gap-2">
                <span className="font-pixel text-[10px] uppercase">
                  {editingRoot ? "Orchestrator" : "Subagent"}
                </span>
                {!editingRoot && (
                  <button
                    onClick={() => selectOne(root?.id ?? null)}
                    className="inline-flex items-center min-h-6 font-mono text-[10px] px-2 py-0.5 border-2 border-line bg-paper hover:bg-stone transition-colors cursor-pointer"
                  >
                    <span className="inline-flex items-center gap-1">
                      <AngleLeftIcon size={10} />
                      back to orchestrator
                    </span>
                  </button>
                )}
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <Field label="Name">
                  {/* Named so the canvas' "edit fields" has something to scroll
                      to and focus — see `editNodeFields`. */}
                  <TextInput
                    id="node-name"
                    value={activeNode?.name ?? ""}
                    onFocus={() => setPreviewState("thinking")}
                    onChange={(e) => patchActive({ name: e.target.value })}
                  />
                </Field>
                <Field label="Role">
                  <TextInput
                    value={activeNode?.role ?? ""}
                    onFocus={() => setPreviewState("thinking")}
                    onChange={(e) => patchActive({ role: e.target.value })}
                  />
                </Field>
              </div>
              <Field
                label="System prompt"
                hint={`${(activeNode?.systemPrompt ?? "").length} chars`}
              >
                <TextArea
                  rows={5}
                  value={activeNode?.systemPrompt ?? ""}
                  onFocus={() => setPreviewState("working")}
                  onChange={(e) => patchActive({ systemPrompt: e.target.value })}
                />
              </Field>
            </Panel>

            <Panel className="p-5 space-y-4">
              {/* Target is a property of the export, not of a node: one repo
                  gets one CLAUDE.md, and every specialist in it is described
                  by that same file. Only the orchestrator offers it. */}
              <Field
                group
                label="Target tool"
                hint={
                  editingRoot
                    ? TARGETS.find((t) => t.id === agent.target)?.hint
                    : "set on the orchestrator — one export, one tool"
                }
              >
                <Segmented<AgentTarget>
                  options={TARGETS.map((t) => ({ id: t.id, label: t.label }))}
                  value={agent.target}
                  onChange={(v) => {
                    // Switching tools can strand the model on one the new tool
                    // can't run (Opus 5 under Gemini CLI), so fall back to the
                    // new tool's first option when that happens. Every node is
                    // checked, not just the root: a specialist left on a model
                    // the new CLI cannot drive is the same bug, one level down.
                    const allowed = modelsFor(v);
                    const ok = (m: string | undefined) => !!m && allowed.some((x) => x.id === m);
                    setAgent((a) => {
                      const g = a.graph ?? graphFromAgent(a);
                      const fixed: AgentGraph = {
                        ...g,
                        nodes: g.nodes.map((n) =>
                          isAgentKind(n.kind) && !ok(n.model) ? { ...n, model: allowed[0].id } : n,
                        ),
                      };
                      return agentFromGraph({ ...a, target: v }, fixed);
                    });
                    setSaved(false);
                  }}
                />
              </Field>

              <div className="grid sm:grid-cols-2 gap-4">
                <Field label="Model">
                  <Select
                    options={modelsFor(agent.target).map((m) => ({
                      id: m.id,
                      label: m.label,
                      hint: m.vendor,
                      icon: <VendorMark vendor={m.vendor} />,
                    }))}
                    value={activeNode?.model ?? agent.model}
                    onChange={(v) => patchActive({ model: v })}
                  />
                </Field>
                <Field
                  group
                  label="Temperature"
                  hint={(activeNode?.temperature ?? agent.temperature).toFixed(2)}
                >
                  <Slider
                    aria-label="Temperature"
                    className="heroui-brand w-full"
                    maxValue={1}
                    minValue={0}
                    step={0.05}
                    value={activeNode?.temperature ?? agent.temperature}
                    onChange={(v) =>
                      patchActive({ temperature: Array.isArray(v) ? v[0] : v })
                    }
                  >
                    <Slider.Track>
                      <Slider.Fill />
                      <Slider.Thumb />
                    </Slider.Track>
                  </Slider>
                </Field>
              </div>
            </Panel>

            {/* MASCOT PICKER */}
            <Panel className="p-5">
              {/* Edits the active node like every other field on this page, so
                  it names which one — a specialist's mascot is what its node
                  wears on the canvas, and picking one while a subagent is
                  selected used to look like it had changed the agent's. */}
              <Field
                group
                label="Mascot"
                hint={
                  editingRoot
                    ? "on the agent card and the root node"
                    : `on ${activeNode?.name ?? "this specialist"}'s node`
                }
              >
                <div className="grid grid-cols-5 sm:grid-cols-10 gap-2 mt-1">
                  {MASCOT_ORDER.map((s) => (
                    <button
                      key={s}
                      title={MASCOTS[s].label}
                      aria-pressed={activeNode?.mascot === s}
                      onClick={() => {
                        patchActive({ mascot: s });
                        setPreviewState(s);
                      }}
                      className={`mascot-stage relative overflow-hidden aspect-square grid place-items-center border-2 cursor-pointer transition-[border-color,box-shadow] duration-150 outline-none focus-visible:border-coral focus-visible:shadow-[0_0_0_2px_var(--coral)] ${
                        activeNode?.mascot === s
                          ? "border-coral shadow-[0_0_0_2px_var(--coral)]"
                          : "border-line hover:border-ink-soft"
                      }`}
                    >
                      <Mascot state={s} size={40} />
                    </button>
                  ))}
                </div>
              </Field>
            </Panel>

            {/* COMPONENTS — live search of skills.sh + the aitmpl catalog */}
            <Panel className="p-5">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-pixel text-[10px] uppercase">Components</span>
                <Badge tone="coral">{activeComponents.length} on this agent</Badge>
              </div>
              {/* Says where a pick lands. On a graph with specialists this is
                  the difference between arming the orchestrator and arming the
                  one subagent that should own the tool. */}
              <p className="font-mono text-[10px] text-muted mb-3">
                {locked ? (
                  <>canvas is locked — unlock it to add or remove components</>
                ) : (
                  <>
                    picks attach to <b>{activeNode?.name ?? "—"}</b>
                    {agent.skills.length !== activeComponents.length && (
                      <> · {agent.skills.length} across the whole graph</>
                    )}
                  </>
                )}
              </p>

              {activeComponents.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {activeComponents.map((n) => (
                    <button
                      key={n.id}
                      disabled={locked}
                      onClick={() => {
                        setGraph(removeNode(graph, n.id));
                        setPreviewState("wizard");
                      }}
                      title={locked ? "Canvas is locked" : `remove ${nodeRef(n)}`}
                      className="inline-flex items-center gap-1 min-h-6 font-mono text-[10px] px-2 py-0.5 border-2 border-line bg-fill text-on-fill hover:bg-coral-text transition-colors disabled:opacity-50 disabled:pointer-events-none"
                    >
                      {n.name} <span className="opacity-70">✕</span>
                    </button>
                  ))}
                </div>
              )}

              <SkillBrowser selected={activePicks} onToggle={toggleSkill} />
            </Panel>
          </div>

          {/* PREVIEW / EXPORT */}
          <div className="space-y-5 min-w-0 lg:sticky lg:top-20 self-start">
            <Panel className="p-5 text-center">
              <div className="grain mascot-stage relative pixel-border-sm p-5 overflow-hidden">
                <Mascot state={previewState} size={104} />
              </div>
              <div className="mt-3 font-sans font-bold truncate">{agent.name}</div>
              <div className="font-mono text-[11px] text-muted truncate">{agent.role}</div>
              <div className="flex items-center justify-center gap-1.5 mt-2">
                <Badge>{subagentsOf(graph).length} subagents</Badge>
                <Badge>{agent.skills.length} components</Badge>
              </div>
              {/* Status line — the shimmer sweep replaces the old staggered
                  dots, which stuttered at 1.4s with three delayed copies. */}
              <div className="flex items-center justify-center mt-2 font-mono text-[10px] text-muted">
                <span
                  className="t-shimmer"
                  data-text={MASCOTS[previewState].blurb}
                >
                  {MASCOTS[previewState].blurb}
                </span>
              </div>
            </Panel>

            <Panel className="overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b-2 border-line bg-stone">
                <span className="font-mono text-[11px]">{output.filename}</span>
                <PixelButton
                  onClick={copy}
                  className={`!px-2 !py-1 !text-[9px] ${copiedKey === "output" ? "!bg-ok !text-paper" : ""}`}
                >
                  <CopyLabel done={copiedKey === "output"} />
                </PixelButton>
              </div>
              {/* Switching target tool swaps a long CLAUDE.md for a short
                  mcp.json — tweening the box keeps the sidebar from jumping. */}
              <ResizeBox max={420}>
                <pre className="p-3 text-[11px] font-mono leading-relaxed whitespace-pre-wrap">
                  {output.content}
                </pre>
              </ResizeBox>
            </Panel>

            {/* INSTALL — wraps the official skills CLI */}
            <Panel className="overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b-2 border-line bg-coral-text text-paper">
                <span className="font-pixel text-[10px] uppercase">Install</span>
                <Badge tone="ink">{repos.length} repos</Badge>
              </div>
              <div className="p-3 space-y-3">
                <div>
                  <div className="font-mono text-[9px] uppercase text-muted mb-1">existing project</div>
                  <div className="flex items-stretch gap-1.5">
                    <code className="flex-1 min-w-0 bg-stone border-2 border-line px-2 py-1.5 font-mono text-[10px] overflow-auto whitespace-nowrap">
                      {install}
                    </code>
                    <PixelButton
                      onClick={() => doCopy(install, "install")}
                      disabled={repos.length === 0}
                      className={`!px-2 !py-1 !text-[9px] shrink-0 ${copiedKey === "install" ? "!bg-ok !text-paper" : ""}`}
                    >
                      <CopyLabel done={copiedKey === "install"} />
                    </PixelButton>
                  </div>
                </div>

                <div>
                  <div className="font-mono text-[9px] uppercase text-muted mb-1">new project</div>
                  <div className="flex items-stretch gap-1.5">
                    <code className="flex-1 min-w-0 bg-stone border-2 border-line px-2 py-1.5 font-mono text-[10px] overflow-auto whitespace-nowrap">
                      {newProj}
                    </code>
                    <PixelButton
                      onClick={() => doCopy(newProj, "newproj")}
                      className={`!px-2 !py-1 !text-[9px] shrink-0 ${copiedKey === "newproj" ? "!bg-ok !text-paper" : ""}`}
                    >
                      <CopyLabel done={copiedKey === "newproj"} />
                    </PixelButton>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                  <PixelButton
                    variant="ghost"
                    onClick={downloadManifest}
                    disabled={repos.length === 0}
                    className="w-full"
                  >
                    <span className="inline-flex items-center gap-1">
                      <DownloadIcon size={12} />
                      .skills.json
                    </span>
                  </PixelButton>
                  <PixelButton variant="ghost" onClick={downloadAgent} className="w-full">
                    <span className="inline-flex items-center gap-1">
                      <DownloadIcon size={12} />
                      agent.json
                    </span>
                  </PixelButton>
                </div>
                <p className="font-mono text-[9px] text-muted leading-relaxed">
                  Uses the official <b>skills</b> CLI — auto-detects your agent (Claude
                  Code, Cursor, Codex…) and writes into its skills dir.
                </p>

                {/* serve the agent over MCP to any model */}
                <div className="pt-2 border-t-2 border-line">
                  <div className="font-mono text-[9px] uppercase text-muted mb-1">serve over MCP</div>
                  <div className="flex items-stretch gap-1.5">
                    <code className="flex-1 min-w-0 bg-stone border-2 border-line px-2 py-1.5 font-mono text-[10px] overflow-auto whitespace-nowrap">
                      {mcpServeCommand()}
                    </code>
                    <PixelButton
                      onClick={() => doCopy(mcpServeCommand(), "mcp")}
                      className={`!px-2 !py-1 !text-[9px] shrink-0 ${copiedKey === "mcp" ? "!bg-ok !text-paper" : ""}`}
                    >
                      <CopyLabel done={copiedKey === "mcp"} />
                    </PixelButton>
                  </div>
                  <p className="font-mono text-[9px] text-muted leading-relaxed mt-1.5">
                    Drop <b>agent.json</b> in your repo, add the line to any MCP client —
                    serves this agent&apos;s prompt + skills to Claude, GPT, Gemini…
                  </p>
                </div>
              </div>
            </Panel>

            {/* CONTEXT DOCS — the `.md` files the repo needs so the entry file
                can stay short. Which ones appear is read off the agent: an
                agent that never mentions the database gets no DATA.md. */}
            <Panel className="overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b-2 border-line bg-stone">
                <span className="font-pixel text-[10px] uppercase">Context docs</span>
                <Badge>{formatTokens(docsTokens)} tokens</Badge>
              </div>
              <div className="p-3 space-y-3">
                <p className="font-mono text-[9px] text-muted leading-relaxed">
                  One file per task, each with frontmatter saying when to read it and
                  when to skip it — so <b>{entryFile}</b> stays short and a model loads
                  one doc instead of the whole repo.
                </p>

                <ul className="space-y-1.5">
                  {docs.map((doc) => {
                    const ai = aiDocs[doc.path];
                    const shown = ai ?? doc;
                    const isGenerating = generatingDoc === doc.path;
                    return (
                      <li key={doc.path} className="bg-stone border-2 border-line p-2 space-y-1.5">
                        <div className="min-w-0">
                          <div className="font-mono text-[10px] truncate flex items-center gap-1.5">
                            {doc.path}
                            {ai && <Badge tone="coral">AI</Badge>}
                          </div>
                          <div className="font-mono text-[9px] text-muted truncate">
                            {doc.why} · {formatTokens(shown.tokens)}
                          </div>
                        </div>
                        <div className="flex items-stretch gap-1.5">
                          {aiDocsAllowed ? (
                            <PixelButton
                              variant="ghost"
                              onClick={() => generateDoc(doc.path)}
                              disabled={isGenerating}
                              className="flex-1 min-w-0 !px-2 !py-1 !text-[9px]"
                            >
                              {isGenerating ? "Writing…" : ai ? "Regenerate" : "Generate with AI"}
                            </PixelButton>
                          ) : (
                            <Link href="/pricing" className="flex-1 min-w-0">
                              <PixelButton variant="ghost" className="w-full !px-2 !py-1 !text-[9px]">
                                <span className="inline-flex items-center gap-1">
                                  <LockIcon size={10} />
                                  AI fill — {cheapestPlanWith("ai-docs").label}
                                </span>
                              </PixelButton>
                            </Link>
                          )}
                          <PixelButton
                            onClick={() => doCopy(shown.content, doc.path)}
                            className={`!px-2 !py-1 !text-[9px] shrink-0 ${copiedKey === doc.path ? "!bg-ok !text-paper" : ""}`}
                          >
                            <CopyLabel done={copiedKey === doc.path} />
                          </PixelButton>
                        </div>
                      </li>
                    );
                  })}
                </ul>

                {docError && (
                  <Notice tone="error" className="!text-[9px]">
                    {docError}
                  </Notice>
                )}

                <PixelButton variant="ghost" onClick={downloadDocs} className="w-full">
                  <span className="inline-flex items-center gap-1">
                    <DownloadIcon size={12} />
                    docs.zip
                  </span>
                </PixelButton>

                <p className="font-mono text-[9px] text-muted leading-relaxed">
                  Scaffolds, not claims — every section says what belongs in it and
                  leaves a <b>TODO</b> for the facts. This app knows your agent, never
                  the repo it lands in.
                </p>
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function BuildPage() {
  return (
    <Suspense fallback={<PageLoading what="the composer" />}>
      <Builder />
    </Suspense>
  );
}
