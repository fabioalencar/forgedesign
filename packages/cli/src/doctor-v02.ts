// `forge doctor` for format v0.2 (spec/format.md §7) — three OKF conformance
// checks ahead of the Forge profile rules. The order matters: an OKF failure
// explains itself ("this file isn't a concept"), where the profile rules
// downstream of it would only report confusing symptoms.
//
// Most per-file validation already happens in `parseConcept`, so the format
// package stays the single authority on what the spec says and doctor renders
// its findings. What lives here is what needs more than one file (duplicate
// ids, link resolution) or the filesystem and git (immutability, generation).

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  allEntries,
  BUNDLE_DIR,
  buildBundleIndex,
  type ConceptProblemKind,
  findDuplicateIds,
  findUnresolvedRefs,
  INDEX_FILENAME,
  isFeedbackSource,
  isGeneratedIndex,
  isSupportedFormatVersion,
  isTaskStatus,
  type ParsedConcept,
  parseConcept,
  parseFrontmatter,
  parseTodos,
  ROOT_CONCEPT_FILES,
  type ScannedBundle,
  scanBundle,
} from "@forgedesign/format";
import { type DoctorFinding, type DoctorResult, finding } from "./doctor-types.js";
import { readFreezes } from "./freezes.js";
import { repoRoot as findRepoRoot, git } from "./git.js";

/** Which rule name each concept-level problem reports under. */
const PROBLEM_RULES: Record<ConceptProblemKind, string> = {
  "frontmatter-missing": "okf-frontmatter",
  "frontmatter-invalid": "okf-frontmatter",
  "type-missing": "okf-type",
  "type-unknown": "invalid-enum",
  "type-mismatched-directory": "misplaced-concept",
  "id-missing": "id-shape",
  "id-malformed": "id-shape",
  "id-filename-mismatch": "id-shape",
  "status-invalid": "invalid-enum",
  "domain-status-invalid": "invalid-enum",
};

/**
 * Generators whose output doctor recognizes. An unknown generator means either
 * a typo or a tool this record's tooling does not own — both worth reporting.
 */
const KNOWN_GENERATORS = [/^forge freeze$/, /^forge-cli\/.+$/];

export interface DoctorV02Options {
  /** bundle directory relative to the repo root; defaults to `design` */
  recordRoot?: string;
  /** git ref accepted decisions are compared against; defaults to HEAD */
  base?: string;
}

export async function runDoctorV02(
  root: string,
  manifest: { formatVersion?: unknown },
  options: DoctorV02Options = {},
): Promise<DoctorResult> {
  const recordRoot = options.recordRoot ?? BUNDLE_DIR;
  const bundle = await scanBundle(root, { recordRoot });

  if (!bundle.present) {
    return {
      findings: [
        finding(
          "unparseable",
          `forge.json declares formatVersion 0.2 but there is no ${recordRoot}/ bundle — run \`forge upgrade --to 0.2\``,
          "forge.json",
        ),
      ],
      exitCode: 2,
    };
  }

  const freezeIds = (await readFreezes(root).catch(() => [])).map(
    (_, index) => `FREEZE-${String(index + 1).padStart(3, "0")}`,
  );
  const latestFreezeId = freezeIds.at(-1) ?? null;
  const todos = bundle.concepts.find((concept) => concept.type === "Task Ledger");
  const taskIds = todos
    ? allEntries(parseTodos(todos.body)).flatMap((e) => (e.id ? [e.id] : []))
    : [];

  const declaredIds = [
    ...bundle.concepts.flatMap((concept) => (concept.id ? [concept.id] : [])),
    ...taskIds,
  ];
  const knownIds = new Set([...declaredIds, ...freezeIds]);

  const findings: DoctorFinding[] = [
    ...conceptProblems(bundle),
    ...checkReservedFiles(bundle),
    ...checkIndexCurrency(bundle),
    ...checkDuplicateIds(declaredIds),
    ...checkResolvableRefs(bundle, knownIds),
    ...checkTaskStatuses(todos),
    ...checkFeedbackRules(bundle),
    ...(await checkGeneratedFiles(root, recordRoot, bundle, latestFreezeId)),
    ...(await checkDecisionImmutability(root, recordRoot, bundle, options.base)),
    ...checkFormatVersion(manifest),
    ...checkRootFileCase(bundle),
    ...checkAmendments(bundle),
  ];

  return { findings, exitCode: findings.length > 0 ? 1 : 0 };
}

/** Rules 1, 2, 4 (shape), 6 — everything `parseConcept` already decided. */
function conceptProblems(bundle: ScannedBundle): DoctorFinding[] {
  return bundle.concepts.flatMap((concept) =>
    concept.problems.map((problem) =>
      finding(PROBLEM_RULES[problem.kind], problem.message, relFile(concept.relPath)),
    ),
  );
}

/**
 * Rule 3: OKF reserves `index.md` and `log.md` and forbids frontmatter in them,
 * except a bundle-root `index.md` that may carry `okf_version` and nothing else.
 */
function checkReservedFiles(bundle: ScannedBundle): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const file of bundle.reserved) {
    const parsed = parseFrontmatter(file.text);
    if (parsed.kind === "missing") continue;

    const isRootIndex = file.relPath === "index.md";
    if (!isRootIndex) {
      findings.push(
        finding(
          "okf-reserved",
          `${file.name} must not carry frontmatter (OKF §8/§9); only the bundle-root index.md may, and only okf_version`,
          relFile(file.relPath),
        ),
      );
      continue;
    }
    if (parsed.kind === "invalid") {
      findings.push(finding("okf-frontmatter", parsed.message, relFile(file.relPath)));
      continue;
    }
    const extra = Object.keys(parsed.data).filter((key) => key !== "okf_version");
    if (extra.length > 0) {
      findings.push(
        finding(
          "okf-reserved",
          `index.md may only carry okf_version in frontmatter (OKF §12); found ${extra.join(", ")}`,
          relFile(file.relPath),
        ),
      );
    }
  }
  return findings;
}

/**
 * The index is derived, so it can go stale — a concept added by hand leaves it
 * describing a record that no longer exists. It cannot carry a `generated`
 * stamp (OKF allows only `okf_version` in an index's frontmatter), so the
 * marker lives in the body and currency is checked by rebuilding and comparing.
 * A hand-written index is left alone: it never claimed to be generated.
 */
function checkIndexCurrency(bundle: ScannedBundle): DoctorFinding[] {
  const index = bundle.reserved.find((file) => file.relPath === INDEX_FILENAME);
  if (!index || !isGeneratedIndex(index.text)) return [];
  if (buildBundleIndex(bundle.concepts) === index.text) return [];
  return [
    finding(
      "stale-index",
      "index.md no longer matches the concepts in the bundle — run `forge index`",
      relFile(index.relPath),
    ),
  ];
}

/** Rule 4: every id is unique across the record. */
function checkDuplicateIds(ids: string[]): DoctorFinding[] {
  return findDuplicateIds(ids).map((duplicate) =>
    finding("duplicate-id", `${duplicate.id} is declared ${duplicate.count} times`),
  );
}

/** Rule 5: every referenced id resolves somewhere in the record. */
function checkResolvableRefs(
  bundle: ScannedBundle,
  knownIds: ReadonlySet<string>,
): DoctorFinding[] {
  return bundle.concepts.flatMap((concept) =>
    findUnresolvedRefs(concept.refs, knownIds).map((ref) =>
      finding(
        "unresolved-ref",
        `${ref} is referenced but not declared anywhere in the record`,
        relFile(concept.relPath),
      ),
    ),
  );
}

/** Rule 6, for the one ledger: task statuses inside todos.md's body. */
function checkTaskStatuses(todos: ParsedConcept | undefined): DoctorFinding[] {
  if (!todos) return [];
  return allEntries(parseTodos(todos.body)).flatMap((entry) => {
    const status = entry.fields.status;
    if (!status || isTaskStatus(status)) return [];
    return [
      finding(
        "invalid-enum",
        `${entry.id ?? "(no id)"}: invalid task status "${status}"`,
        relFile(todos.relPath),
      ),
    ];
  });
}

/** Rules 6 and 7 for feedback: a valid source, and a disposition that links its outcome. */
function checkFeedbackRules(bundle: ScannedBundle): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const concept of bundle.concepts) {
    if (concept.type !== "Feedback") continue;
    const file = relFile(concept.relPath);
    const id = concept.id ?? "(no id)";

    const source = concept.frontmatter.source;
    if (typeof source === "string" && !isFeedbackSource(source)) {
      findings.push(finding("invalid-enum", `${id}: invalid feedback source "${source}"`, file));
    }

    const status = concept.domainStatus?.value;
    const resolution =
      typeof concept.frontmatter.resolution === "string" ? concept.frontmatter.resolution : null;
    if (status === "accepted" && !resolution?.startsWith("TASK-")) {
      findings.push(
        finding("disposition-rule", `${id}: accepted feedback must link a TASK-### id`, file),
      );
    }
    if (status === "declined" && !resolution?.startsWith("DDR-")) {
      findings.push(
        finding("disposition-rule", `${id}: declined feedback must link a DDR-### id`, file),
      );
    }
  }
  return findings;
}

/**
 * Rule 8: a file carrying `generated` names a generator we know, is not stale
 * against the latest freeze, and has not been hand-edited.
 *
 * Hand-editing is detected the way DDR immutability is — against git. A
 * generated file whose content changed while its `generated` stamp did not was
 * edited by a person, not regenerated by its tool.
 */
async function checkGeneratedFiles(
  root: string,
  recordRoot: string,
  bundle: ScannedBundle,
  latestFreezeId: string | null,
): Promise<DoctorFinding[]> {
  const derived = bundle.concepts.filter((concept) => concept.generated !== null);
  if (derived.length === 0) return [];

  const findings: DoctorFinding[] = [];
  for (const concept of derived) {
    const file = relFile(concept.relPath);
    const generator = concept.generated?.by ?? "";
    if (!KNOWN_GENERATORS.some((pattern) => pattern.test(generator))) {
      findings.push(
        finding("derived-marker", `${file} names an unknown generator "${generator}"`, file),
      );
    }
    const freeze = concept.frontmatter.freeze;
    if (latestFreezeId && typeof freeze === "string" && freeze !== latestFreezeId) {
      findings.push(
        finding(
          "derived-marker",
          `${file} is stale: generated for ${freeze}, but the latest freeze is ${latestFreezeId}`,
          file,
          "warning",
        ),
      );
    }
  }

  const committed = await readCommitted(
    root,
    derived.map((concept) => path.join(recordRoot, concept.relPath)),
  );
  for (const concept of derived) {
    const relPath = path.join(recordRoot, concept.relPath);
    const head = committed.get(relPath);
    if (head === undefined) continue; // never committed — nothing to compare against

    const headConcept = parseConcept(concept.relPath, head);
    if (headConcept.generated === null) continue; // only just became generated
    if (headConcept.generated.at !== concept.generated?.at) continue; // regenerated, as it should be
    if (head.trim() !== concept.raw.trim()) {
      findings.push(
        finding(
          "derived-edited",
          "a generated file changed without its `generated` stamp changing — it was hand-edited; regenerate it instead",
          relFile(concept.relPath),
        ),
      );
    }
  }
  return findings;
}

/** Rule 9: accepted decisions are unchanged since acceptance (amend via supersession). */
/**
 * The file with an `amended_by:` frontmatter line removed, so the immutability
 * rule can permit that key being added to an accepted decision and nothing else
 * (DDR-087). Line-based on purpose: it must normalise this and nothing more.
 */
function withoutAmendedBy(text: string): string {
  // Only inside the leading frontmatter. A blanket line filter would also hide
  // an edit to an `amended_by:` line quoted in a decision's *body* — DDR-087
  // itself contains one as an example — and an exemption that reaches further
  // than its reason is how a narrow rule stops being narrow.
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return text;
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (close === -1) return text;
  const front = lines.slice(0, close).filter((line) => !/^amended_by:\s/.test(line));
  return [...front, ...lines.slice(close)].join("\n");
}

/**
 * `base` decides what "since" means, and it is the difference between a check
 * and a formality. Against `HEAD` this catches an uncommitted edit — useful to
 * the author, vacuous in CI where the working tree *is* HEAD. Against the
 * branch a change is headed for, it catches the amendment itself, which is the
 * last point a reviewer could still act on it (TASK-328).
 */
async function checkDecisionImmutability(
  root: string,
  recordRoot: string,
  bundle: ScannedBundle,
  base = "HEAD",
): Promise<DoctorFinding[]> {
  const accepted = bundle.concepts.filter(
    (concept) => concept.type === "Decision" && concept.domainStatus?.value === "accepted",
  );
  if (accepted.length === 0) return [];

  const committed = await readCommitted(
    root,
    accepted.map((concept) => path.join(recordRoot, concept.relPath)),
    base,
  );

  const findings: DoctorFinding[] = [];
  for (const concept of accepted) {
    const head = committed.get(path.join(recordRoot, concept.relPath));
    if (head === undefined) continue;
    const headConcept = parseConcept(concept.relPath, head);
    if (headConcept.domainStatus?.value !== "accepted") continue; // just became accepted
    // One exemption, and it has to be exactly one: DDR-087 records a *partial*
    // amendment by adding `amended_by` while the decision stays accepted. This
    // rule only fires while a decision reads `accepted`, so flipping a status to
    // `superseded` was already permitted by construction — the format allowed
    // the blunt instrument and forbade the precise one, which is why nine
    // amendments went unrecorded. Everything outside that key still has to match
    // exactly, so adding it cannot smuggle in another edit.
    if (withoutAmendedBy(head).trim() !== withoutAmendedBy(concept.raw).trim()) {
      findings.push(
        finding(
          "ddr-immutable",
          `accepted DDR content changed since ${base} — amend by superseding with a new DDR`,
          relFile(concept.relPath),
        ),
      );
    }
  }
  return findings;
}

/** Rule 10: forge.json#formatVersion is one the tooling understands. */
function checkFormatVersion(manifest: { formatVersion?: unknown }): DoctorFinding[] {
  const version = typeof manifest.formatVersion === "string" ? manifest.formatVersion : undefined;
  if (isSupportedFormatVersion(version)) return [];
  return [
    finding(
      "format-version",
      `forge.json#formatVersion "${manifest.formatVersion ?? "(missing)"}" is not supported by this tooling — run \`forge upgrade\``,
      "forge.json",
    ),
  ];
}

/**
 * Rule 11: a bundle-root file whose name matches a spec file except in case.
 * On a case-insensitive filesystem the two are one path, so the record would
 * otherwise read as valid while the expected file can never be created.
 */
function checkRootFileCase(bundle: ScannedBundle): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const concept of bundle.concepts) {
    if (concept.relPath.includes("/")) continue;
    if (ROOT_CONCEPT_FILES[concept.relPath] !== undefined) continue;
    const expected = Object.keys(ROOT_CONCEPT_FILES).find(
      (name) => name.toLowerCase() === concept.relPath.toLowerCase(),
    );
    if (expected === undefined) continue;
    findings.push(
      finding(
        "case-collision",
        `${concept.relPath} differs from the record file ${expected} only by case — on this filesystem they are the same path. Rename it to ${expected}.`,
        relFile(concept.relPath),
      ),
    );
  }
  return findings;
}

/**
 * Rule 12: an amendment is recorded on both decisions, not just the amending one.
 *
 * `amends: [DDR-###]` is a claim, and this is what makes it checkable: the
 * decision it names has to carry the matching `amended_by`. Without the pair,
 * a reader who opens the *older* decision finds it marked accepted with nothing
 * to say part of it has moved — which is exactly how nine amendments went
 * unrecorded before DDR-087, and how the next nine would go too.
 *
 * **It reads the declared key and never the prose**, which is the whole design
 * (DDR-090). A scan for "amends `DDR-###`" credits DDR-087 with amending four
 * decisions, because DDR-087's text *lists* the relationships it is describing —
 * so a prose rule cannot tell a decision asserting an amendment from one quoting
 * someone else's. The cost is that this catches a half-recorded amendment and
 * not an undeclared one; declaring it stays the author's move.
 */
function checkAmendments(bundle: ScannedBundle): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const decisions = new Map(
    bundle.concepts
      .filter((concept) => concept.type === "Decision" && concept.id)
      .map((concept) => [concept.id as string, concept]),
  );

  for (const concept of bundle.concepts) {
    if (concept.type !== "Decision" || !concept.id) continue;
    // Only an *accepted* amendment obliges its target to record anything. A
    // draft is a proposal, and demanding the back-reference before it is
    // accepted would write into an immutable file on the strength of something
    // that may never be agreed — and could not be taken back, since the
    // immutability exemption permits adding `amended_by`, not removing it. The
    // check therefore fires at acceptance, which is the moment the claim
    // becomes true.
    if (concept.domainStatus?.value !== "accepted") continue;
    const declared = concept.frontmatter.amends;
    if (declared === undefined) continue;

    const targets = readIdList(declared);
    if (targets === null) {
      findings.push(
        finding(
          "amendment-shape",
          "`amends` must be a decision id or a list of them, e.g. `amends: [DDR-088]`",
          relFile(concept.relPath),
        ),
      );
      continue;
    }

    for (const target of targets) {
      if (target === concept.id) {
        findings.push(
          finding(
            "amendment-shape",
            `${concept.id} lists itself in \`amends\``,
            relFile(concept.relPath),
          ),
        );
        continue;
      }
      const amended = decisions.get(target);
      if (!amended) {
        findings.push(
          finding(
            "amendment-shape",
            `${concept.id} amends ${target}, which is not a decision in this record`,
            relFile(concept.relPath),
          ),
        );
        continue;
      }
      const back = readIdList(amended.frontmatter.amended_by) ?? [];
      if (!back.includes(concept.id)) {
        findings.push(
          finding(
            "amendment-unrecorded",
            `${concept.id} says it amends ${target}, but ${target} does not list it in \`amended_by\` — add \`amended_by: [${[...back, concept.id].join(", ")}]\``,
            relFile(amended.relPath),
          ),
        );
      }
    }
  }
  return findings;
}

/** One id or a list of them; null when it is neither. */
function readIdList(value: unknown): string[] | null {
  if (typeof value === "string") return [value.trim()];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    out.push(entry.trim());
  }
  return out;
}

// --- helpers ---------------------------------------------------------------

/** Paths in findings are bundle-relative, matching how the spec names them. */
function relFile(relPath: string): string {
  return `${BUNDLE_DIR}/${relPath}`;
}

/** `git show HEAD:<path>` for each path, skipping ones git does not know. */
async function readCommitted(
  root: string,
  relPaths: string[],
  base = "HEAD",
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  // realpath first: git resolves symlinks in its own toplevel output (macOS
  // /tmp -> /private/tmp), so comparing against the raw root can silently
  // produce a bogus relative path and skip every check.
  const realRoot = await fs.realpath(root).catch(() => root);
  const gitRoot = await findRepoRoot(realRoot);
  if (!gitRoot) return contents;

  for (const relPath of relPaths) {
    const fromGitRoot = path.relative(gitRoot, path.join(realRoot, relPath));
    try {
      contents.set(relPath, await git(gitRoot, ["show", `${base}:${fromGitRoot}`]));
    } catch {
      // not committed yet
    }
  }
  return contents;
}
