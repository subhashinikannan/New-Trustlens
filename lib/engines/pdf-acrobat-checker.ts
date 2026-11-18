/**
 * Acrobat Pro–style PDF Accessibility Checker (add-on)
 *
 * ADDITIVE ENGINE — runs AFTER the existing 15 heuristic checks in
 * `pdf-analyzer.ts` and never changes or removes them. It inspects the real
 * PDF object model (catalog, structure tree, content streams, fonts,
 * annotations, AcroForm, encryption dictionary, JavaScript) and replicates
 * the 32 rules of Adobe Acrobat Pro's "Accessibility Checker":
 *
 *   Document      : Accessibility permission flag, Image-only PDF, Tagged PDF,
 *                   Logical reading order, Primary language, Title, Bookmarks,
 *                   Color contrast
 *   Page content  : Tagged content, Tagged annotations, Tab order, Character
 *                   encoding, Tagged multimedia, Screen flicker, Scripts,
 *                   Timed responses, Navigation links
 *   Forms         : Tagged form fields, Field descriptions
 *   Alternate text: Figures alternate text, Nested alternate text, Associated
 *                   with content, Hides annotation, Other elements alternate text
 *   Tables        : Rows, TH and TD, Headers, Regularity, Summary
 *   Lists         : List items, Lbl and LBody
 *   Headings      : Appropriate nesting
 *
 * Each rule resolves to an Acrobat status — Passed | Failed |
 * Needs Manual Check | Skipped — and the full 32-rule report is returned
 * (Acrobat's "Accessibility Report"). Only Failed / Needs Manual Check rules
 * become issues, and a rule is NOT emitted when an existing heuristic check
 * already reported the same problem (see `overlapsWith`), so scores are never
 * double-penalised.
 *
 * Also exports `autoFixPdfAccessibility()` — the equivalent of Acrobat's
 * "Fix" actions for the rules that can be fixed automatically.
 */
import type { AccessibilityIssue } from "../types/audit";

type PdfLib = typeof import("pdf-lib");
type PDFDocumentT = Awaited<ReturnType<PdfLib["PDFDocument"]["load"]>>;
// Loosely-typed handles to pdf-lib objects (keeps this module decoupled
// from pdf-lib's internal class hierarchy).
/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = any;

export type AcrobatStatus =
  | "Passed"
  | "Failed"
  | "Needs Manual Check"
  | "Skipped";

export type AcrobatCategory =
  | "Document"
  | "Page Content"
  | "Forms"
  | "Alternate Text"
  | "Tables"
  | "Lists"
  | "Headings";

export interface AcrobatRuleResult {
  ruleId: string; // PDF-AC-xx
  rule: string; // Acrobat rule name
  category: AcrobatCategory;
  status: AcrobatStatus;
  details: string;
  pages?: number[];
  count?: number;
  autoFixable: boolean;
  /** Existing heuristic check that already covers this finding (if any) */
  coveredBy?: string;
}

export interface AcrobatCheckerReport {
  engine: "acrobat-pro-checker";
  standard: "WCAG 2.x / PDF/UA-1 (ISO 14289-1)";
  summary: {
    passed: number;
    failed: number;
    needsManualCheck: number;
    skipped: number;
    total: number;
  };
  rules: AcrobatRuleResult[];
  structure: {
    tagged: boolean;
    markedFlag: boolean;
    hasStructTree: boolean;
    lang?: string;
    title?: string;
    displayDocTitle: boolean;
    encrypted: boolean;
    pageCount: number;
    structElements: number;
    figures: number;
    tables: number;
    lists: number;
    headings: number;
    formFields: number;
    annotations: number;
    links: number;
    fonts: number;
    hasBookmarks: boolean;
    hasJavaScript: boolean;
    tagCounts: Record<string, number>;
  };
}

// ─────────────────────────────────────────────────────────────
// Rule catalogue (mirrors Acrobat's Accessibility Checker Options)
// ─────────────────────────────────────────────────────────────
interface RuleDef {
  id: string;
  rule: string;
  category: AcrobatCategory;
  wcag: string;
  wcagName: string;
  level: "A" | "AA" | "AAA";
  pdfua: string;
  severity: "critical" | "high" | "medium" | "low";
  impact: string;
  fix: string;
  autoFixable: boolean;
  /** existing pdf-analyzer testIds that report the same failure */
  overlapsWith?: string[];
}

const RULES: RuleDef[] = [
  // ── Document ──
  {
    id: "PDF-AC-01",
    rule: "Accessibility permission flag",
    category: "Document",
    wcag: "4.1.2",
    wcagName: "Name, Role, Value",
    level: "A",
    pdfua: "ISO 14289-1 §7.16",
    severity: "critical",
    impact: "Screen readers are blocked from extracting the document's text",
    fix: "Acrobat: File > Properties > Security > No Security, or enable 'Enable text access for screen reader devices for the visually impaired'.",
    autoFixable: false,
    overlapsWith: ["PDF-13"],
  },
  {
    id: "PDF-AC-02",
    rule: "Image-only PDF",
    category: "Document",
    wcag: "1.1.1",
    wcagName: "Non-text Content",
    level: "A",
    pdfua: "ISO 14289-1 §7.1",
    severity: "critical",
    impact: "Pages contain only images of text — nothing is readable by assistive technology",
    fix: "Acrobat: All tools > Scan & OCR > Recognize text > In this file. Then autotag the document.",
    autoFixable: false,
  },
  {
    id: "PDF-AC-03",
    rule: "Tagged PDF",
    category: "Document",
    wcag: "1.3.1",
    wcagName: "Info and Relationships",
    level: "A",
    pdfua: "ISO 14289-1 §7.1 (MarkInfo /Marked, StructTreeRoot)",
    severity: "critical",
    impact: "Without a structure tree, screen readers cannot understand headings, lists, tables or reading order",
    fix: "Acrobat: All tools > Prepare for accessibility > Automatically tag PDF (or Autotag document).",
    autoFixable: false,
    overlapsWith: ["PDF-01"],
  },
  {
    id: "PDF-AC-04",
    rule: "Logical reading order",
    category: "Document",
    wcag: "1.3.2",
    wcagName: "Meaningful Sequence",
    level: "A",
    pdfua: "ISO 14289-1 §7.2",
    severity: "low",
    impact: "If the tag order differs from visual order, content is announced out of sequence",
    fix: "Verify in the Tags panel and Reading Order tool (Shift+Ctrl+U): drag regions in the Order panel to match the visual order.",
    autoFixable: false,
    overlapsWith: ["PDF-02"],
  },
  {
    id: "PDF-AC-05",
    rule: "Primary language",
    category: "Document",
    wcag: "3.1.1",
    wcagName: "Language of Page",
    level: "A",
    pdfua: "ISO 14289-1 §7.2 (Catalog /Lang)",
    severity: "high",
    impact: "Screen readers use the wrong pronunciation rules",
    fix: "Acrobat: File > Properties > Advanced > Reading Options > Language.",
    autoFixable: true,
    overlapsWith: ["PDF-07"],
  },
  {
    id: "PDF-AC-06",
    rule: "Title",
    category: "Document",
    wcag: "2.4.2",
    wcagName: "Page Titled",
    level: "A",
    pdfua: "ISO 14289-1 §7.1 (dc:title, ViewerPreferences /DisplayDocTitle)",
    severity: "medium",
    impact: "The window/tab shows the file name instead of a meaningful document title",
    fix: "Acrobat: File > Properties > Description > Title, and Initial View > Show: Document Title.",
    autoFixable: true,
    overlapsWith: ["PDF-06"],
  },
  {
    id: "PDF-AC-07",
    rule: "Bookmarks",
    category: "Document",
    wcag: "2.4.5",
    wcagName: "Multiple Ways",
    level: "AA",
    pdfua: "ISO 14289-1 §7.17",
    severity: "medium",
    impact: "Long documents (21+ pages) without bookmarks are hard to navigate",
    fix: "Acrobat: Bookmarks panel > New Bookmarks From Structure (select heading tags).",
    autoFixable: true,
    overlapsWith: ["PDF-08"],
  },
  {
    id: "PDF-AC-08",
    rule: "Color contrast",
    category: "Document",
    wcag: "1.4.3",
    wcagName: "Contrast (Minimum)",
    level: "AA",
    pdfua: "—",
    severity: "low",
    impact: "Low-contrast text is hard to read for low-vision users",
    fix: "Verify text contrast is at least 4.5:1 (3:1 for large text). Acrobat users can apply Preferences > Accessibility > Replace document colors.",
    autoFixable: false,
  },
  // ── Page content ──
  {
    id: "PDF-AC-09",
    rule: "Tagged content",
    category: "Page Content",
    wcag: "1.3.1",
    wcagName: "Info and Relationships",
    level: "A",
    pdfua: "ISO 14289-1 §7.1 (content tagged or Artifact)",
    severity: "high",
    impact: "Untagged content is skipped or read in random order by screen readers",
    fix: "Tag the content in the Reading Order tool or Content panel, or mark decorative items as Background/Artifact.",
    autoFixable: false,
    overlapsWith: ["PDF-14"],
  },
  {
    id: "PDF-AC-10",
    rule: "Tagged annotations",
    category: "Page Content",
    wcag: "1.3.1",
    wcagName: "Info and Relationships",
    level: "A",
    pdfua: "ISO 14289-1 §7.18.1",
    severity: "medium",
    impact: "Comments and markup are not part of the structure and may be missed",
    fix: "Tags panel options > Tag Annotations, then re-add the annotations; or mark them as artifacts.",
    autoFixable: false,
  },
  {
    id: "PDF-AC-11",
    rule: "Tab order",
    category: "Page Content",
    wcag: "2.4.3",
    wcagName: "Focus Order",
    level: "A",
    pdfua: "ISO 14289-1 §7.18.3 (page /Tabs /S)",
    severity: "medium",
    impact: "Keyboard focus moves through links/fields in an order that differs from the structure",
    fix: "Acrobat: Page Thumbnails > Page Properties > Tab Order > Use Document Structure.",
    autoFixable: true,
  },
  {
    id: "PDF-AC-12",
    rule: "Character encoding",
    category: "Page Content",
    wcag: "1.3.1",
    wcagName: "Info and Relationships",
    level: "A",
    pdfua: "ISO 14289-1 §7.21.7 (ToUnicode)",
    severity: "high",
    impact: "Characters cannot be mapped to Unicode — text is read as gibberish or skipped",
    fix: "Re-create the PDF from source with Unicode-capable fonts (fonts with ToUnicode CMaps).",
    autoFixable: false,
    overlapsWith: ["PDF-04"],
  },
  {
    id: "PDF-AC-13",
    rule: "Tagged multimedia",
    category: "Page Content",
    wcag: "1.1.1",
    wcagName: "Non-text Content",
    level: "A",
    pdfua: "ISO 14289-1 §7.18.6",
    severity: "high",
    impact: "Embedded audio/video/3D content is invisible to assistive technology",
    fix: "Tag multimedia objects (Tags panel > Find > Unmarked Annotations) or mark them as artifacts.",
    autoFixable: false,
  },
  {
    id: "PDF-AC-14",
    rule: "Screen flicker",
    category: "Page Content",
    wcag: "2.3.1",
    wcagName: "Three Flashes or Below Threshold",
    level: "A",
    pdfua: "—",
    severity: "medium",
    impact: "Flashing content can trigger seizures",
    fix: "Verify multimedia/scripts do not flash more than 3 times per second; remove flickering elements.",
    autoFixable: false,
  },
  {
    id: "PDF-AC-15",
    rule: "Scripts",
    category: "Page Content",
    wcag: "2.1.1",
    wcagName: "Keyboard",
    level: "A",
    pdfua: "—",
    severity: "medium",
    impact: "Scripted behaviour may be unusable with keyboard or assistive technology",
    fix: "Verify every script-driven feature is keyboard-operable and does not interfere with AT.",
    autoFixable: false,
  },
  {
    id: "PDF-AC-16",
    rule: "Timed responses",
    category: "Page Content",
    wcag: "2.2.1",
    wcagName: "Timing Adjustable",
    level: "A",
    pdfua: "—",
    severity: "medium",
    impact: "Users who need more time may be timed out of forms",
    fix: "Remove JavaScript timeouts or let users extend/disable them.",
    autoFixable: false,
  },
  {
    id: "PDF-AC-17",
    rule: "Navigation links",
    category: "Page Content",
    wcag: "2.4.4",
    wcagName: "Link Purpose (In Context)",
    level: "A",
    pdfua: "ISO 14289-1 §7.18.5 (Link + OBJR, /Contents)",
    severity: "medium",
    impact: "Links not in the tag tree cannot be reached or announced by screen readers",
    fix: "Use Create Link, or in the Tags panel Find > Unmarked Links > Tag Element. Add link descriptions.",
    autoFixable: false,
  },
  // ── Forms ──
  {
    id: "PDF-AC-18",
    rule: "Tagged form fields",
    category: "Forms",
    wcag: "1.3.1",
    wcagName: "Info and Relationships",
    level: "A",
    pdfua: "ISO 14289-1 §7.18.4 (Form + OBJR)",
    severity: "high",
    impact: "Form fields outside the structure tree are not announced in context",
    fix: "Acrobat: Automatically tag PDF tags existing form fields, or Tags panel > Find > Unmarked Annotations.",
    autoFixable: false,
  },
  {
    id: "PDF-AC-19",
    rule: "Field descriptions",
    category: "Forms",
    wcag: "4.1.2",
    wcagName: "Name, Role, Value",
    level: "A",
    pdfua: "ISO 14289-1 §7.18.4 (/TU)",
    severity: "high",
    impact: "Screen readers announce fields without a meaningful name",
    fix: "Prepare a form > field Properties > General > Tooltip.",
    autoFixable: true,
    overlapsWith: ["PDF-09"],
  },
  // ── Alternate text ──
  {
    id: "PDF-AC-20",
    rule: "Figures alternate text",
    category: "Alternate Text",
    wcag: "1.1.1",
    wcagName: "Non-text Content",
    level: "A",
    pdfua: "ISO 14289-1 §7.3",
    severity: "critical",
    impact: "Images are announced as 'graphic' with no description",
    fix: "Prepare for accessibility > Add alternate text, or Tags panel > Figure > Properties > Alternate Text. Mark decorative figures as artifacts.",
    autoFixable: false,
    overlapsWith: ["PDF-03"],
  },
  {
    id: "PDF-AC-21",
    rule: "Nested alternate text",
    category: "Alternate Text",
    wcag: "1.1.1",
    wcagName: "Non-text Content",
    level: "A",
    pdfua: "ISO 14289-1 §7.3",
    severity: "medium",
    impact: "Alt text on nested elements is never read because a parent's alt text replaces it",
    fix: "Remove alternate text from the nested child elements (Tags panel > Properties).",
    autoFixable: false,
  },
  {
    id: "PDF-AC-22",
    rule: "Associated with content",
    category: "Alternate Text",
    wcag: "1.1.1",
    wcagName: "Non-text Content",
    level: "A",
    pdfua: "ISO 14289-1 §7.3",
    severity: "medium",
    impact: "Alt text on an element with no page content is never read",
    fix: "Remove the alt text or attach the element to content (Tags panel > Create Tag From Selection).",
    autoFixable: false,
  },
  {
    id: "PDF-AC-23",
    rule: "Hides annotation",
    category: "Alternate Text",
    wcag: "1.1.1",
    wcagName: "Non-text Content",
    level: "A",
    pdfua: "ISO 14289-1 §7.3",
    severity: "medium",
    impact: "Alt text on a parent element hides the annotation/link it contains",
    fix: "Remove alternate text from elements that contain annotations.",
    autoFixable: false,
  },
  {
    id: "PDF-AC-24",
    rule: "Other elements alternate text",
    category: "Alternate Text",
    wcag: "1.1.1",
    wcagName: "Non-text Content",
    level: "A",
    pdfua: "ISO 14289-1 §7.3, §7.18.1 (/Contents)",
    severity: "medium",
    impact: "Annotations, formulas and multimedia have no text alternative",
    fix: "Add a description (/Contents or Alternate Text) to annotations, Formula tags and multimedia.",
    autoFixable: false,
  },
  // ── Tables ──
  {
    id: "PDF-AC-25",
    rule: "Rows",
    category: "Tables",
    wcag: "1.3.1",
    wcagName: "Info and Relationships",
    level: "A",
    pdfua: "ISO 14289-1 §7.5",
    severity: "high",
    impact: "Rows outside Table/THead/TBody/TFoot break table navigation",
    fix: "In the Tags panel, move each TR under Table, THead, TBody or TFoot.",
    autoFixable: false,
    overlapsWith: ["PDF-05"],
  },
  {
    id: "PDF-AC-26",
    rule: "TH and TD",
    category: "Tables",
    wcag: "1.3.1",
    wcagName: "Info and Relationships",
    level: "A",
    pdfua: "ISO 14289-1 §7.5",
    severity: "high",
    impact: "Cells outside rows are not announced as table cells",
    fix: "In the Tags panel, place every TH and TD inside a TR.",
    autoFixable: false,
    overlapsWith: ["PDF-05"],
  },
  {
    id: "PDF-AC-27",
    rule: "Headers",
    category: "Tables",
    wcag: "1.3.1",
    wcagName: "Info and Relationships",
    level: "A",
    pdfua: "ISO 14289-1 §7.5",
    severity: "high",
    impact: "Data cells cannot be associated with headers",
    fix: "Reading Order tool > Table Editor: mark header cells as TH and set Scope.",
    autoFixable: false,
    overlapsWith: ["PDF-05"],
  },
  {
    id: "PDF-AC-28",
    rule: "Regularity",
    category: "Tables",
    wcag: "1.3.1",
    wcagName: "Info and Relationships",
    level: "A",
    pdfua: "ISO 14289-1 §7.5",
    severity: "medium",
    impact: "Rows with different column counts confuse table navigation",
    fix: "Use Table Editor: fix ColSpan/RowSpan so every row has the same number of columns.",
    autoFixable: false,
  },
  {
    id: "PDF-AC-29",
    rule: "Summary",
    category: "Tables",
    wcag: "1.3.1",
    wcagName: "Info and Relationships",
    level: "A",
    pdfua: "ISO 14289-1 §7.5 (optional)",
    severity: "low",
    impact: "Complex tables are easier to understand with a summary (optional)",
    fix: "Reading Order tool > select table > Edit Table Summary.",
    autoFixable: false,
  },
  // ── Lists ──
  {
    id: "PDF-AC-30",
    rule: "List items",
    category: "Lists",
    wcag: "1.3.1",
    wcagName: "Info and Relationships",
    level: "A",
    pdfua: "ISO 14289-1 §7.6",
    severity: "medium",
    impact: "List items outside a list are not announced as a list",
    fix: "In the Tags panel, place every LI inside an L element.",
    autoFixable: false,
  },
  {
    id: "PDF-AC-31",
    rule: "Lbl and LBody",
    category: "Lists",
    wcag: "1.3.1",
    wcagName: "Info and Relationships",
    level: "A",
    pdfua: "ISO 14289-1 §7.6",
    severity: "medium",
    impact: "Bullets/labels and list bodies are not associated with their items",
    fix: "In the Tags panel, place Lbl and LBody inside an LI element.",
    autoFixable: false,
  },
  // ── Headings ──
  {
    id: "PDF-AC-32",
    rule: "Appropriate nesting",
    category: "Headings",
    wcag: "1.3.1",
    wcagName: "Info and Relationships",
    level: "A",
    pdfua: "ISO 14289-1 §7.4",
    severity: "medium",
    impact: "Skipped heading levels make heading navigation confusing",
    fix: "Retag headings so levels do not skip (H1 > H2 > H3) using the Tags panel or Reading Order tool.",
    autoFixable: false,
    overlapsWith: ["PDF-11"],
  },
];

const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

const STANDARD_TYPES = new Set([
  "Document", "Part", "Art", "Sect", "Div", "BlockQuote", "Caption", "TOC",
  "TOCI", "Index", "NonStruct", "Private", "P", "H", "H1", "H2", "H3", "H4",
  "H5", "H6", "L", "LI", "Lbl", "LBody", "Table", "TR", "TH", "TD", "THead",
  "TBody", "TFoot", "Span", "Quote", "Note", "Reference", "BibEntry", "Code",
  "Link", "Annot", "Ruby", "RB", "RT", "RP", "Warichu", "WT", "WP", "Figure",
  "Formula", "Form", "Artifact", "DocumentFragment", "Aside", "Title", "FENote",
  "Sub", "Em", "Strong",
]);

const STANDARD_14 = new Set([
  "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
  "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
  "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic", "Symbol",
  "ZapfDingbats",
]);

const MULTIMEDIA_SUBTYPES = new Set(["Screen", "Movie", "Sound", "RichMedia", "3D"]);
const NON_CONTENT_ANNOTS = new Set(["Popup", "PrinterMark", "TrapNet", "Watermark"]);

// ─────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────
export async function runAcrobatProChecks(
  fileBuffer: Buffer,
  fileName: string,
  existingIssues: AccessibilityIssue[] = [],
  onProgress?: (msg: string) => void,
): Promise<{ issues: AccessibilityIssue[]; report: AcrobatCheckerReport | null }> {
  let lib: PdfLib;
  let doc: PDFDocumentT;
  try {
    lib = await import("pdf-lib");
    doc = await lib.PDFDocument.load(fileBuffer, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
  } catch {
    onProgress?.("Acrobat Pro checker: PDF structure could not be loaded, skipped.");
    return { issues: [], report: null };
  }

  onProgress?.("Running Acrobat Pro accessibility checker (32 rules)...");
  const ctx = new Ctx(lib, doc);
  const results = new Map<string, AcrobatRuleResult>();
  const set = (
    id: string,
    status: AcrobatStatus,
    details: string,
    extra: Partial<AcrobatRuleResult> = {},
  ) => {
    const def = RULE_BY_ID.get(id)!;
    results.set(id, {
      ruleId: id,
      rule: def.rule,
      category: def.category,
      status,
      details,
      autoFixable: def.autoFixable && status === "Failed",
      ...extra,
    });
  };

  const facts = ctx.collect();

  // ═════ DOCUMENT ═════
  // Accessibility permission flag
  if (!facts.encrypted) set("PDF-AC-01", "Passed", "Document is not encrypted.");
  else if (facts.permissionAllowsAT)
    set("PDF-AC-01", "Passed", "Encrypted, but text access for screen readers is permitted.");
  else
    set("PDF-AC-01", "Failed", `Security settings (P=${facts.permissionP}) block content extraction for assistive technology.`);

  // Image-only PDF
  if (facts.encrypted && !facts.permissionAllowsAT) {
    set("PDF-AC-02", "Skipped", "Encrypted content streams cannot be inspected.");
  } else if (facts.imageOnlyPages.length > 0) {
    set(
      "PDF-AC-02",
      "Failed",
      facts.imageOnlyPages.length === facts.pageCount
        ? `All ${facts.pageCount} pages contain images but no real text (scanned / image-only).`
        : `${facts.imageOnlyPages.length} of ${facts.pageCount} pages are image-only (no text layer).`,
      { pages: facts.imageOnlyPages, count: facts.imageOnlyPages.length },
    );
  } else set("PDF-AC-02", "Passed", "Every page with images also has a text layer.");

  // Tagged PDF
  if (facts.hasStructTree && facts.markedFlag)
    set("PDF-AC-03", "Passed", `Structure tree present (${facts.structCount} elements), /MarkInfo /Marked true.`);
  else if (facts.hasStructTree && !facts.markedFlag)
    set("PDF-AC-03", "Failed", "A structure tree exists but the catalog /MarkInfo /Marked flag is not set ('Document is Tagged PDF' is off).");
  else set("PDF-AC-03", "Failed", "Document has no structure tree (StructTreeRoot).");

  // Logical reading order
  if (facts.tagged)
    set("PDF-AC-04", "Needs Manual Check", "Verify the tag order in the Tags panel matches the visual reading order.");
  else set("PDF-AC-04", "Failed", "Untagged — reading order must be inferred by the reader and is unreliable.");

  // Primary language
  if (facts.lang) set("PDF-AC-05", "Passed", `Document language: ${facts.lang}.`);
  else set("PDF-AC-05", "Failed", "Catalog has no /Lang entry.");

  // Title
  {
    const problems: string[] = [];
    if (!facts.title) problems.push("no document title in metadata");
    if (!facts.displayDocTitle) problems.push("Initial View does not show the document title (/DisplayDocTitle is not true)");
    if (problems.length === 0) set("PDF-AC-06", "Passed", `Title: "${facts.title}" and shown in title bar.`);
    else set("PDF-AC-06", "Failed", `Title check failed: ${problems.join("; ")}.`);
  }

  // Bookmarks
  if (facts.pageCount < 21) set("PDF-AC-07", "Passed", `Not required (${facts.pageCount} pages; Acrobat requires bookmarks at 21+ pages).`);
  else if (facts.hasBookmarks) set("PDF-AC-07", "Passed", "Bookmarks present.");
  else set("PDF-AC-07", "Failed", `${facts.pageCount}-page document has no bookmarks.`);

  // Color contrast (always manual in Acrobat)
  set("PDF-AC-08", "Needs Manual Check", "Contrast of text against background must be verified manually (WCAG 1.4.3, 4.5:1).");

  // ═════ PAGE CONTENT ═════
  const streamsReadable = !(facts.encrypted && !facts.permissionAllowsAT) && facts.streamsDecoded;
  if (!streamsReadable) {
    set("PDF-AC-09", "Skipped", "Content streams could not be decoded.");
  } else if (!facts.tagged) {
    set("PDF-AC-09", "Failed", "Document is untagged — no page content is tagged or marked as artifact.", {
      pages: facts.untaggedContentPages,
      count: facts.untaggedContentPages.length,
    });
  } else if (facts.untaggedContentPages.length > 0) {
    set(
      "PDF-AC-09",
      "Failed",
      `Content outside tags/artifacts on ${facts.untaggedContentPages.length} page(s): ${facts.untaggedOps.text} text, ${facts.untaggedOps.xobject} image/XObject, ${facts.untaggedOps.path} path operations.`,
      { pages: facts.untaggedContentPages, count: facts.untaggedContentPages.length },
    );
  } else set("PDF-AC-09", "Passed", "All page content is tagged or marked as artifact.");

  // Tagged annotations
  if (facts.otherAnnots === 0) set("PDF-AC-10", "Passed", "No comments/markup annotations.");
  else if (facts.untaggedAnnots.count > 0)
    set("PDF-AC-10", "Failed", `${facts.untaggedAnnots.count} of ${facts.otherAnnots} annotations are not in the tag tree.`, {
      pages: facts.untaggedAnnots.pages,
      count: facts.untaggedAnnots.count,
    });
  else set("PDF-AC-10", "Passed", "All annotations are tagged.");

  // Tab order
  if (facts.pagesWithAnnots.length === 0) set("PDF-AC-11", "Passed", "No pages with links/fields/annotations.");
  else if (facts.badTabOrderPages.length > 0)
    set("PDF-AC-11", "Failed", `${facts.badTabOrderPages.length} page(s) with annotations do not use structure tab order (/Tabs /S).`, {
      pages: facts.badTabOrderPages,
      count: facts.badTabOrderPages.length,
    });
  else set("PDF-AC-11", "Passed", "Tab order follows document structure on all pages.");

  // Character encoding
  if (facts.fontCount === 0) set("PDF-AC-12", "Passed", "No fonts used.");
  else if (facts.badEncodingFonts.length > 0)
    set("PDF-AC-12", "Failed", `${facts.badEncodingFonts.length} font(s) cannot be mapped to Unicode: ${facts.badEncodingFonts.slice(0, 5).join(", ")}${facts.badEncodingFonts.length > 5 ? "…" : ""}.`, {
      count: facts.badEncodingFonts.length,
    });
  else set("PDF-AC-12", "Passed", `All ${facts.fontCount} fonts have reliable Unicode mapping.`);

  // Tagged multimedia
  if (facts.multimedia.total === 0) set("PDF-AC-13", "Passed", "No multimedia.");
  else if (facts.multimedia.untagged > 0)
    set("PDF-AC-13", "Failed", `${facts.multimedia.untagged} of ${facts.multimedia.total} multimedia objects are not tagged.`, {
      pages: facts.multimedia.pages,
      count: facts.multimedia.untagged,
    });
  else set("PDF-AC-13", "Passed", "All multimedia objects are tagged.");

  // Screen flicker
  if (facts.multimedia.total > 0 || facts.hasJavaScript)
    set("PDF-AC-14", "Needs Manual Check", "Document contains multimedia or scripts — verify nothing flashes more than 3 times per second.");
  else set("PDF-AC-14", "Passed", "No multimedia or scripts that could cause flicker.");

  // Scripts
  if (facts.hasJavaScript)
    set("PDF-AC-15", "Needs Manual Check", `Document contains ${facts.jsCount} JavaScript action(s) — verify they are keyboard-accessible.`, { count: facts.jsCount });
  else set("PDF-AC-15", "Passed", "No JavaScript.");

  // Timed responses
  if (facts.hasTimers)
    set("PDF-AC-16", "Needs Manual Check", "JavaScript timers (setTimeOut/setInterval) found — verify users can extend time limits.");
  else set("PDF-AC-16", "Passed", "No timed responses detected.");

  // Navigation links
  if (facts.links.total === 0) set("PDF-AC-17", "Passed", "No links.");
  else {
    const p: string[] = [];
    if (facts.links.untagged > 0) p.push(`${facts.links.untagged} of ${facts.links.total} links are not tagged (no /StructParent / Link OBJR)`);
    if (facts.links.noContents > 0) p.push(`${facts.links.noContents} links have no description (/Contents)`);
    if (facts.links.untagged > 0) set("PDF-AC-17", "Failed", p.join("; ") + ".", { pages: facts.links.pages, count: facts.links.untagged });
    else if (facts.links.noContents > 0) set("PDF-AC-17", "Needs Manual Check", p.join("; ") + " — also check for repetitive navigation links.", { count: facts.links.noContents });
    else set("PDF-AC-17", "Passed", `All ${facts.links.total} links are tagged and described.`);
  }

  // ═════ FORMS ═════
  if (facts.widgets.total === 0) {
    set("PDF-AC-18", "Passed", "No form fields.");
    set("PDF-AC-19", "Passed", "No form fields.");
  } else {
    if (facts.widgets.untagged > 0)
      set("PDF-AC-18", "Failed", `${facts.widgets.untagged} of ${facts.widgets.total} form field widgets are not tagged.`, {
        pages: facts.widgets.pages,
        count: facts.widgets.untagged,
      });
    else set("PDF-AC-18", "Passed", "All form fields are tagged.");
    if (facts.widgets.noTooltip > 0)
      set("PDF-AC-19", "Failed", `${facts.widgets.noTooltip} of ${facts.widgets.total} form fields have no tooltip/description (/TU).`, {
        count: facts.widgets.noTooltip,
      });
    else set("PDF-AC-19", "Passed", "All form fields have descriptions.");
  }

  // ═════ ALTERNATE TEXT / TABLES / LISTS / HEADINGS (structure-tree rules) ═════
  const st = facts.struct;
  if (!facts.hasStructTree) {
    for (const id of [
      "PDF-AC-20", "PDF-AC-21", "PDF-AC-22", "PDF-AC-23", "PDF-AC-25",
      "PDF-AC-26", "PDF-AC-27", "PDF-AC-28", "PDF-AC-29", "PDF-AC-30",
      "PDF-AC-31", "PDF-AC-32",
    ])
      set(id, "Skipped", "Document is untagged — structure rule cannot run (see Tagged PDF).");
  } else {
    // Figures
    if (st.figures === 0) set("PDF-AC-20", "Passed", "No Figure tags.");
    else if (st.figuresNoAlt > 0)
      set("PDF-AC-20", "Failed", `${st.figuresNoAlt} of ${st.figures} figures have no alternate text.`, { pages: uniq(st.figuresNoAltPages), count: st.figuresNoAlt });
    else set("PDF-AC-20", "Passed", `All ${st.figures} figures have alternate text.`);

    set(...countRule("PDF-AC-21", st.nestedAlt, "elements have alternate text nested inside a parent that also has alternate text", "No nested alternate text."));
    set(...countRule("PDF-AC-22", st.altNoContent, "elements have alternate text but no associated page content", "All alternate text is associated with content."));
    set(...countRule("PDF-AC-23", st.altHidesAnnot, "elements have alternate text that hides an annotation", "No alternate text hides annotations."));

    // Tables
    if (st.tables === 0) {
      for (const id of ["PDF-AC-25", "PDF-AC-26", "PDF-AC-27", "PDF-AC-28", "PDF-AC-29"])
        set(id, "Passed", "No tables.");
    } else {
      set(...countRule("PDF-AC-25", st.badRows, "TR elements are not children of Table, THead, TBody or TFoot", "All rows are correctly nested."));
      set(...countRule("PDF-AC-26", st.badCells, "TH/TD elements are not children of TR", "All cells are inside rows."));
      set(...countRule("PDF-AC-27", st.tablesNoHeader, `of ${st.tables} tables have no header cells (TH)`, "All tables have header cells."));
      set(...countRule("PDF-AC-28", st.irregularTables, `of ${st.tables} tables have rows with different numbers of columns`, "All tables are regular."));
      if (st.tablesNoSummary > 0)
        set("PDF-AC-29", "Needs Manual Check", `${st.tablesNoSummary} of ${st.tables} tables have no summary (optional).`, { count: st.tablesNoSummary });
      else set("PDF-AC-29", "Passed", "All tables have summaries.");
    }

    // Lists
    set(...countRule("PDF-AC-30", st.badLI, "LI elements are not children of L", st.lists === 0 ? "No lists." : "All list items are inside lists."));
    set(...countRule("PDF-AC-31", st.badLblLBody, "Lbl/LBody elements are not children of LI", st.lists === 0 ? "No lists." : "All Lbl/LBody are inside list items."));

    // Headings
    if (st.headingLevels.length === 0)
      set("PDF-AC-32", facts.pageCount > 3 ? "Needs Manual Check" : "Passed", facts.pageCount > 3 ? "No heading tags found — verify headings are tagged." : "No headings.");
    else if (st.headingSkips.length > 0)
      set("PDF-AC-32", "Failed", `Heading levels skip: ${st.headingSkips.slice(0, 5).join(", ")}${st.headingSkips.length > 5 ? "…" : ""}.`, { count: st.headingSkips.length });
    else set("PDF-AC-32", "Passed", `${st.headingLevels.length} headings, nesting is correct.`);
  }

  // Other elements alternate text (annotations, formulas, multimedia)
  {
    const n = facts.annotsNoContents + st.formulasNoAlt;
    if (n > 0)
      set("PDF-AC-24", "Failed", `${facts.annotsNoContents} annotation/multimedia object(s) without a description${st.formulasNoAlt ? ` and ${st.formulasNoAlt} Formula tag(s) without alternate text` : ""}.`, { count: n });
    else set("PDF-AC-24", "Passed", "Other elements have alternate text.");
  }

  // ─── Build issues (Failed / Needs Manual Check only, de-duplicated) ───
  const existingIds = new Set(existingIssues.map((i) => i.testId));
  const issues: AccessibilityIssue[] = [];
  const rules = RULES.map((r) => results.get(r.id)!).filter(Boolean);

  for (const res of rules) {
    if (res.status !== "Failed" && res.status !== "Needs Manual Check") continue;
    const def = RULE_BY_ID.get(res.ruleId)!;
    // Untagged documents: reading order / tagged content are consequences of
    // the single "Tagged PDF" failure — kept in the report, not re-penalised.
    if (
      !facts.tagged &&
      (res.ruleId === "PDF-AC-04" || res.ruleId === "PDF-AC-09") &&
      results.get("PDF-AC-03")?.status === "Failed"
    ) {
      res.coveredBy = "PDF-AC-03";
      continue;
    }
    const covered = def.overlapsWith?.find((t) => existingIds.has(t));
    if (covered && !hasExtraDetail(res, facts)) {
      res.coveredBy = covered;
      continue;
    }
    issues.push(buildIssue(def, res, fileName, covered));
  }

  const summary = {
    passed: rules.filter((r) => r.status === "Passed").length,
    failed: rules.filter((r) => r.status === "Failed").length,
    needsManualCheck: rules.filter((r) => r.status === "Needs Manual Check").length,
    skipped: rules.filter((r) => r.status === "Skipped").length,
    total: rules.length,
  };

  onProgress?.(
    `Acrobat Pro checker: ${summary.passed} passed, ${summary.failed} failed, ${summary.needsManualCheck} need manual check, ${summary.skipped} skipped — ${issues.length} additional issues added.`,
  );

  return {
    issues,
    report: {
      engine: "acrobat-pro-checker",
      standard: "WCAG 2.x / PDF/UA-1 (ISO 14289-1)",
      summary,
      rules,
      structure: {
        tagged: facts.tagged,
        markedFlag: facts.markedFlag,
        hasStructTree: facts.hasStructTree,
        lang: facts.lang,
        title: facts.title,
        displayDocTitle: facts.displayDocTitle,
        encrypted: facts.encrypted,
        pageCount: facts.pageCount,
        structElements: facts.structCount,
        figures: st.figures,
        tables: st.tables,
        lists: st.lists,
        headings: st.headingLevels.length,
        formFields: facts.widgets.total,
        annotations: facts.totalAnnots,
        links: facts.links.total,
        fonts: facts.fontCount,
        hasBookmarks: facts.hasBookmarks,
        hasJavaScript: facts.hasJavaScript,
        tagCounts: st.tagCounts,
      },
    },
  };
}

/**
 * When an existing heuristic already reported the same rule, the Acrobat
 * finding is only added if it carries information the heuristic cannot
 * (e.g. Title fails only because DisplayDocTitle is off, or the struct tree
 * exists but the Marked flag is off).
 */
function hasExtraDetail(res: AcrobatRuleResult, facts: Facts): boolean {
  switch (res.ruleId) {
    case "PDF-AC-06":
      return !!facts.title && !facts.displayDocTitle;
    case "PDF-AC-03":
      return facts.hasStructTree && !facts.markedFlag;
    default:
      return false;
  }
}

function countRule(
  id: string,
  n: number,
  failText: string,
  passText: string,
): [string, AcrobatStatus, string, Partial<AcrobatRuleResult>] {
  return n > 0
    ? [id, "Failed", `${n} ${failText}.`, { count: n }]
    : [id, "Passed", passText, {}];
}

function buildIssue(
  def: RuleDef,
  res: AcrobatRuleResult,
  fileName: string,
  relatedExisting?: string,
): AccessibilityIssue {
  const manual = res.status === "Needs Manual Check";
  const pageText = res.pages && res.pages.length
    ? ` Pages: ${res.pages.slice(0, 15).join(", ")}${res.pages.length > 15 ? "…" : ""}.`
    : "";
  return {
    id: crypto.randomUUID(),
    testId: def.id,
    title: `Acrobat Checker – ${def.rule}${manual ? " (Needs Manual Check)" : ""}`,
    description: `[${def.category} › ${def.rule} › ${res.status}] ${res.details}${pageText}`,
    element: `acrobat: ${def.category.toLowerCase()} / ${def.rule.toLowerCase()}`,
    pageUrl: fileName,
    wcagCriterion: def.wcag,
    wcagName: def.wcagName,
    wcagLevel: def.level,
    severity: manual ? "low" : def.severity,
    impact: def.impact,
    recommendation: def.fix + (def.autoFixable ? " (Auto-fix available: TrustLens PDF Auto-Fix.)" : ""),
    category: "pdf",
    source: "pdf-analyzer",
    confidence: manual ? "low" : "high",
    checkData: {
      engine: "Acrobat Pro Accessibility Checker",
      acrobatRule: def.rule,
      acrobatCategory: def.category,
      checkerStatus: res.status,
      pdfUA: def.pdfua,
      autoFixable: def.autoFixable,
      ...(res.count !== undefined ? { count: res.count } : {}),
      ...(res.pages?.length ? { pages: res.pages.slice(0, 50).join(", ") } : {}),
      ...(relatedExisting ? { relatedCheck: relatedExisting } : {}),
    },
  };
}

function uniq(a: number[]): number[] {
  return [...new Set(a)].sort((x, y) => x - y);
}

// ─────────────────────────────────────────────────────────────
// PDF object-model inspection
// ─────────────────────────────────────────────────────────────
interface StructFacts {
  figures: number;
  figuresNoAlt: number;
  figuresNoAltPages: number[];
  formulasNoAlt: number;
  nestedAlt: number;
  altNoContent: number;
  altHidesAnnot: number;
  tables: number;
  badRows: number;
  badCells: number;
  tablesNoHeader: number;
  irregularTables: number;
  tablesNoSummary: number;
  lists: number;
  badLI: number;
  badLblLBody: number;
  headingLevels: number[];
  headingSkips: string[];
  headingTargets: { level: number; title: string; pageRef: Obj }[];
  tagCounts: Record<string, number>;
}

interface Facts {
  pageCount: number;
  encrypted: boolean;
  permissionP?: number;
  permissionAllowsAT: boolean;
  hasStructTree: boolean;
  markedFlag: boolean;
  tagged: boolean;
  structCount: number;
  lang?: string;
  title?: string;
  displayDocTitle: boolean;
  hasBookmarks: boolean;
  streamsDecoded: boolean;
  imageOnlyPages: number[];
  untaggedContentPages: number[];
  untaggedOps: { text: number; xobject: number; path: number };
  totalAnnots: number;
  otherAnnots: number;
  untaggedAnnots: { count: number; pages: number[] };
  annotsNoContents: number;
  pagesWithAnnots: number[];
  badTabOrderPages: number[];
  fontCount: number;
  badEncodingFonts: string[];
  multimedia: { total: number; untagged: number; pages: number[] };
  hasJavaScript: boolean;
  jsCount: number;
  hasTimers: boolean;
  links: { total: number; untagged: number; noContents: number; pages: number[] };
  widgets: { total: number; untagged: number; noTooltip: number; pages: number[] };
  struct: StructFacts;
}

class Ctx {
  constructor(
    private lib: PdfLib,
    private doc: PDFDocumentT,
  ) {}

  private N = (s: string) => this.lib.PDFName.of(s);

  res(o: Obj): Obj {
    if (o instanceof this.lib.PDFRef) return this.doc.context.lookup(o);
    return o;
  }
  get(d: Obj, key: string): Obj {
    d = this.res(d);
    if (!d || !(d instanceof this.lib.PDFDict)) return undefined;
    return this.res(d.get(this.N(key)));
  }
  name(o: Obj): string | undefined {
    o = this.res(o);
    if (o instanceof this.lib.PDFName) return decodeName(o.toString());
    return undefined;
  }
  str(o: Obj): string | undefined {
    o = this.res(o);
    if (o instanceof this.lib.PDFString || o instanceof this.lib.PDFHexString) {
      try {
        return o.decodeText();
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  num(o: Obj): number | undefined {
    o = this.res(o);
    if (o instanceof this.lib.PDFNumber) return o.asNumber();
    return undefined;
  }
  bool(o: Obj): boolean | undefined {
    o = this.res(o);
    if (o instanceof this.lib.PDFBool) return o.asBoolean();
    return undefined;
  }
  arr(o: Obj): Obj[] {
    o = this.res(o);
    if (o instanceof this.lib.PDFArray) return o.asArray();
    return o === undefined || o === null ? [] : [o];
  }
  isDict(o: Obj): boolean {
    return this.res(o) instanceof this.lib.PDFDict;
  }
  decodeStream(o: Obj): string | null {
    o = this.res(o);
    try {
      if (o instanceof this.lib.PDFRawStream) {
        const bytes = this.lib.decodePDFRawStream(o).decode();
        return bytesToLatin1(bytes);
      }
      if (o && typeof o.getContents === "function") {
        return bytesToLatin1(o.getContents());
      }
    } catch {
      return null;
    }
    return null;
  }

  collect(): Facts {
    const doc = this.doc;
    const catalog = doc.catalog;
    const pages = doc.getPages();
    const pageRefIndex = new Map<string, number>();
    pages.forEach((p, i) => pageRefIndex.set(p.ref.toString(), i + 1));

    // ─ Encryption / permissions ─
    const encDict = this.res((doc.context.trailerInfo as Obj).Encrypt);
    const encrypted = !!encDict;
    let permissionP: number | undefined;
    let permissionAllowsAT = true;
    if (encrypted) {
      permissionP = this.num(this.get(encDict, "P"));
      const R = this.num(this.get(encDict, "R")) ?? 2;
      if (permissionP !== undefined) {
        const p = permissionP >>> 0;
        permissionAllowsAT = R >= 3 ? (p & 512) !== 0 || (p & 16) !== 0 : (p & 16) !== 0;
      }
    }

    // ─ Catalog-level ─
    const structRoot = this.get(catalog, "StructTreeRoot");
    const hasStructTree = !!structRoot && this.isDict(structRoot);
    const markedFlag = this.bool(this.get(this.get(catalog, "MarkInfo"), "Marked")) === true;
    const lang = this.str(this.get(catalog, "Lang"))?.trim() || undefined;
    let title: string | undefined;
    try {
      title = doc.getTitle()?.trim() || undefined;
    } catch {
      title = undefined;
    }
    const displayDocTitle = this.bool(this.get(this.get(catalog, "ViewerPreferences"), "DisplayDocTitle")) === true;
    const outlines = this.get(catalog, "Outlines");
    const hasBookmarks = !!outlines && !!this.get(outlines, "First");

    // ─ Pages: content, annotations, fonts ─
    const imageOnlyPages: number[] = [];
    const untaggedContentPages: number[] = [];
    const untaggedOps = { text: 0, xobject: 0, path: 0 };
    let streamsDecoded = true;
    let totalAnnots = 0;
    let otherAnnots = 0;
    const untaggedAnnots = { count: 0, pages: [] as number[] };
    let annotsNoContents = 0;
    const pagesWithAnnots: number[] = [];
    const badTabOrderPages: number[] = [];
    const fontsSeen = new Map<string, string | null>(); // key -> problem
    const multimedia = { total: 0, untagged: 0, pages: [] as number[] };
    const links = { total: 0, untagged: 0, noContents: 0, pages: [] as number[] };
    const widgets = { total: 0, untagged: 0, noTooltip: 0, pages: [] as number[] };

    pages.forEach((page, idx) => {
      const pageNo = idx + 1;
      const node = page.node as Obj;
      const resources = this.inheritedResources(node);

      // Content stream analysis
      const contents = this.arr(this.res(node.get(this.N("Contents"))));
      let src = "";
      for (const c of contents) {
        const s = this.decodeStream(c);
        if (s === null) {
          streamsDecoded = false;
          continue;
        }
        src += s + "\n";
      }
      const xobjects = this.get(resources, "XObject");
      const scan = scanContent(src, (name) => this.name(this.get(this.get(xobjects, name), "Subtype")));
      if (scan.textOps === 0 && scan.imageDos > 0) imageOnlyPages.push(pageNo);
      const untagged = scan.untaggedText + scan.untaggedXObject + scan.untaggedPath;
      if (untagged > 0) {
        untaggedContentPages.push(pageNo);
        untaggedOps.text += scan.untaggedText;
        untaggedOps.xobject += scan.untaggedXObject;
        untaggedOps.path += scan.untaggedPath;
      }

      // Fonts (page + one level of form XObjects)
      this.collectFonts(resources, fontsSeen);
      if (xobjects && this.isDict(xobjects)) {
        for (const [, v] of (this.res(xobjects) as Obj).entries()) {
          const xo = this.res(v);
          if (xo && this.name(this.get(xo.dict ?? xo, "Subtype")) === "Form") {
            this.collectFonts(this.get(xo.dict ?? xo, "Resources"), fontsSeen);
          }
        }
      }

      // Annotations
      const annots = this.arr(this.res(node.get(this.N("Annots"))));
      let counted = 0;
      for (const a of annots) {
        const ad = this.res(a);
        if (!this.isDict(ad)) continue;
        const subtype = this.name(this.get(ad, "Subtype")) || "";
        if (NON_CONTENT_ANNOTS.has(subtype)) continue;
        // Hidden annotations (flag bit 2) don't need tags
        const F = this.num(this.get(ad, "F")) ?? 0;
        if (F & 2) continue;
        totalAnnots++;
        counted++;
        const tagged = this.get(ad, "StructParent") !== undefined;
        const contentsTxt = this.str(this.get(ad, "Contents"))?.trim();

        if (subtype === "Link") {
          links.total++;
          if (!tagged) {
            links.untagged++;
            links.pages.push(pageNo);
          }
          if (!contentsTxt) links.noContents++;
        } else if (subtype === "Widget") {
          widgets.total++;
          if (!tagged) {
            widgets.untagged++;
            widgets.pages.push(pageNo);
          }
          if (!this.fieldTooltip(ad)) widgets.noTooltip++;
        } else if (MULTIMEDIA_SUBTYPES.has(subtype)) {
          multimedia.total++;
          if (!tagged) {
            multimedia.untagged++;
            multimedia.pages.push(pageNo);
          }
          if (!contentsTxt) annotsNoContents++;
        } else {
          otherAnnots++;
          if (!tagged) {
            untaggedAnnots.count++;
            untaggedAnnots.pages.push(pageNo);
          }
          if (!contentsTxt) annotsNoContents++;
        }
      }
      if (counted > 0) {
        pagesWithAnnots.push(pageNo);
        if (this.name(this.res(node.get(this.N("Tabs")))) !== "S") badTabOrderPages.push(pageNo);
      }
    });

    // ─ JavaScript ─
    const js = this.scanJavaScript();

    // ─ Structure tree ─
    const struct = this.walkStructTree(structRoot, pageRefIndex);

    const badEncodingFonts = [...fontsSeen.entries()].filter(([, p]) => p).map(([k]) => k);

    return {
      pageCount: pages.length,
      encrypted,
      permissionP,
      permissionAllowsAT,
      hasStructTree,
      markedFlag,
      tagged: hasStructTree && markedFlag,
      structCount: Object.values(struct.tagCounts).reduce((a, b) => a + b, 0),
      lang,
      title,
      displayDocTitle,
      hasBookmarks,
      streamsDecoded,
      imageOnlyPages,
      untaggedContentPages,
      untaggedOps,
      totalAnnots,
      otherAnnots,
      untaggedAnnots: { count: untaggedAnnots.count, pages: uniq(untaggedAnnots.pages) },
      annotsNoContents,
      pagesWithAnnots,
      badTabOrderPages,
      fontCount: fontsSeen.size,
      badEncodingFonts,
      multimedia: { ...multimedia, pages: uniq(multimedia.pages) },
      hasJavaScript: js.count > 0,
      jsCount: js.count,
      hasTimers: js.timers,
      links: { ...links, pages: uniq(links.pages) },
      widgets: { ...widgets, pages: uniq(widgets.pages) },
      struct,
    };
  }

  private inheritedResources(node: Obj): Obj {
    let cur = node;
    for (let i = 0; i < 32 && cur; i++) {
      const r = this.get(cur, "Resources");
      if (r) return r;
      cur = this.get(cur, "Parent");
    }
    return undefined;
  }

  private fieldTooltip(widget: Obj): boolean {
    let cur = widget;
    for (let i = 0; i < 16 && cur; i++) {
      const tu = this.str(this.get(cur, "TU"))?.trim();
      if (tu) return true;
      cur = this.get(cur, "Parent");
    }
    return false;
  }

  private collectFonts(resources: Obj, seen: Map<string, string | null>) {
    const fonts = this.get(resources, "Font");
    if (!fonts || !this.isDict(fonts)) return;
    for (const [, ref] of (this.res(fonts) as Obj).entries()) {
      const key = ref instanceof this.lib.PDFRef ? ref.toString() : undefined;
      const f = this.res(ref);
      if (!this.isDict(f)) continue;
      const base = this.name(this.get(f, "BaseFont")) || "(unnamed)";
      const label = `${base.replace(/^[A-Z]{6}\+/, "")}`;
      const id = key ? `${label} [${key}]` : label;
      if (seen.has(id)) continue;
      seen.set(id, this.fontEncodingProblem(f, base));
    }
  }

  /** Returns a problem string when the font cannot be reliably mapped to Unicode. */
  private fontEncodingProblem(f: Obj, base: string): string | null {
    const subtype = this.name(this.get(f, "Subtype"));
    const hasToUnicode = !!this.get(f, "ToUnicode");
    if (hasToUnicode) return null;
    if (subtype === "Type0") {
      const enc = this.name(this.get(f, "Encoding"));
      if (enc === "Identity-H" || enc === "Identity-V" || !enc) return "Type0/Identity without ToUnicode";
      return null; // predefined CMaps (e.g. UniGB-UCS2-H) map to Unicode
    }
    if (subtype === "Type3") {
      const enc = this.get(f, "Encoding");
      return enc ? this.differencesProblem(enc) : "Type3 without encoding";
    }
    const cleanBase = base.replace(/^[A-Z]{6}\+/, "");
    const fd = this.get(f, "FontDescriptor");
    const flags = this.num(this.get(fd, "Flags")) ?? 0;
    const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;
    const enc = this.get(f, "Encoding");
    if (this.isDict(enc)) {
      const p = this.differencesProblem(enc);
      if (p) return p;
    }
    if (symbolic && !STANDARD_14.has(cleanBase) && !enc) return "Symbolic font without ToUnicode";
    return null;
  }

  private differencesProblem(enc: Obj): string | null {
    const diffs = this.arr(this.get(enc, "Differences"));
    let bad = 0;
    for (const d of diffs) {
      const n = this.name(d);
      if (n && /^(g|G|glyph|cid|index|C|c)\d+$/.test(n)) bad++;
    }
    return bad > 0 ? "Custom glyph names without ToUnicode" : null;
  }

  private scanJavaScript(): { count: number; timers: boolean } {
    let count = 0;
    let timers = false;
    const timerRe = /\b(app\.)?set(TimeOut|Interval|Timeout)\s*\(/i;
    for (const [, obj] of this.doc.context.enumerateIndirectObjects()) {
      const d: Obj = obj instanceof this.lib.PDFDict ? obj : (obj as Obj)?.dict;
      if (!d || !(d instanceof this.lib.PDFDict)) continue;
      const S = this.name(d.get(this.N("S")));
      const jsObj = d.get(this.N("JS"));
      if (S === "JavaScript" || jsObj !== undefined) {
        count++;
        let code = this.str(jsObj) ?? "";
        if (!code) {
          const r = this.res(jsObj);
          if (r && !(r instanceof this.lib.PDFDict)) code = this.decodeStream(r) ?? "";
        }
        if (timerRe.test(code)) timers = true;
      }
    }
    // Inline (non-indirect) actions on annotations / catalog OpenAction
    const open = this.get(this.doc.catalog, "OpenAction");
    if (open && this.isDict(open) && this.name(this.get(open, "S")) === "JavaScript") count++;
    return { count, timers };
  }

  private walkStructTree(root: Obj, pageRefIndex: Map<string, number>): StructFacts {
    const sf: StructFacts = {
      figures: 0, figuresNoAlt: 0, figuresNoAltPages: [], formulasNoAlt: 0,
      nestedAlt: 0, altNoContent: 0, altHidesAnnot: 0, tables: 0, badRows: 0,
      badCells: 0, tablesNoHeader: 0, irregularTables: 0, tablesNoSummary: 0,
      lists: 0, badLI: 0, badLblLBody: 0, headingLevels: [], headingSkips: [],
      headingTargets: [], tagCounts: {},
    };
    if (!root || !this.isDict(root)) return sf;

    const roleMap = this.get(root, "RoleMap");
    const resolveRole = (raw: string): string => {
      let t = raw;
      for (let i = 0; i < 10; i++) {
        if (STANDARD_TYPES.has(t)) return t;
        const m = this.name(this.get(roleMap, t));
        if (!m || m === t) break;
        t = m;
      }
      return t;
    };

    const visited = new Set<Obj>();
    let lastHeading = 0;
    let budget = 200_000;

    interface Elem {
      type: string;
      dict: Obj;
      children: Elem[];
      mcids: number;
      objrs: Obj[];
      pageRef: Obj;
    }

    const build = (node: Obj, inheritedPg: Obj): Elem | null => {
      const d = this.res(node);
      if (!this.isDict(d) || visited.has(d) || budget-- <= 0) return null;
      visited.add(d);
      const raw = this.name(this.get(d, "S")) || "";
      const type = resolveRole(raw);
      const pg = this.get(d, "Pg") ? (d as Obj).get(this.N("Pg")) : inheritedPg;
      const el: Elem = { type, dict: d, children: [], mcids: 0, objrs: [], pageRef: pg };
      for (const k of this.arr(this.get(d, "K"))) {
        const kr = this.res(k);
        if (kr instanceof this.lib.PDFNumber) {
          el.mcids++;
          continue;
        }
        if (!this.isDict(kr)) continue;
        const kType = this.name(this.get(kr, "Type"));
        if (kType === "MCR") {
          el.mcids++;
          if (!el.pageRef && this.get(kr, "Pg")) el.pageRef = (kr as Obj).get(this.N("Pg"));
        } else if (kType === "OBJR") {
          el.objrs.push(this.get(kr, "Obj"));
        } else if (this.get(kr, "S")) {
          const c = build(k, el.pageRef);
          if (c) el.children.push(c);
        }
      }
      return el;
    };

    const rootKids: Elem[] = [];
    for (const k of this.arr(this.get(root, "K"))) {
      const e = build(k, undefined);
      if (e) rootKids.push(e);
    }

    const pageOf = (e: Elem): number | undefined => {
      if (!e.pageRef) return undefined;
      return pageRefIndex.get(e.pageRef.toString());
    };
    const hasContent = (e: Elem): boolean =>
      e.mcids > 0 || e.objrs.length > 0 || e.children.some(hasContent);
    const textOf = (e: Elem): string =>
      this.str(this.get(e.dict, "ActualText")) ||
      this.str(this.get(e.dict, "Alt")) ||
      this.str(this.get(e.dict, "T")) ||
      "";

    const attr = (e: Elem, key: string): Obj => {
      const A = this.get(e.dict, "A");
      for (const a of this.arr(A)) {
        const v = this.get(a, key);
        if (v !== undefined) return v;
      }
      return undefined;
    };

    const visit = (e: Elem, parentType: string, ancestorAlt: boolean) => {
      sf.tagCounts[e.type] = (sf.tagCounts[e.type] || 0) + 1;
      const alt = this.str(this.get(e.dict, "Alt"))?.trim();
      const actual = this.str(this.get(e.dict, "ActualText"))?.trim();
      const hasAlt = !!alt;

      if (hasAlt && ancestorAlt) sf.nestedAlt++;
      if (hasAlt && !hasContent(e)) sf.altNoContent++;
      if (hasAlt && e.type !== "Figure" && e.objrs.length > 0) sf.altHidesAnnot++;

      switch (e.type) {
        case "Figure":
          sf.figures++;
          if (!alt && !actual) {
            sf.figuresNoAlt++;
            const p = pageOf(e);
            if (p) sf.figuresNoAltPages.push(p);
          }
          break;
        case "Formula":
          if (!alt && !actual) sf.formulasNoAlt++;
          break;
        case "TR":
          if (!["Table", "THead", "TBody", "TFoot"].includes(parentType)) sf.badRows++;
          break;
        case "TH":
        case "TD":
          if (parentType !== "TR") sf.badCells++;
          break;
        case "Table":
          sf.tables++;
          this.checkTable(e, sf, attr);
          break;
        case "L":
          sf.lists++;
          break;
        case "LI":
          if (parentType !== "L") sf.badLI++;
          break;
        case "Lbl":
        case "LBody":
          if (parentType !== "LI") sf.badLblLBody++;
          break;
      }

      const hm = /^H([1-6])$/.exec(e.type);
      if (hm) {
        const lvl = Number(hm[1]);
        sf.headingLevels.push(lvl);
        if (lastHeading > 0 && lvl > lastHeading + 1) sf.headingSkips.push(`H${lastHeading}→H${lvl}`);
        else if (lastHeading === 0 && lvl > 1) sf.headingSkips.push(`first heading is H${lvl}`);
        lastHeading = lvl;
        const t = (textOf(e) || `Heading ${sf.headingLevels.length}`).slice(0, 120);
        sf.headingTargets.push({ level: lvl, title: t, pageRef: e.pageRef ?? firstPageRef(e) });
      }

      for (const c of e.children) visit(c, e.type, ancestorAlt || hasAlt);
    };

    const firstPageRef = (e: Elem): Obj => {
      if (e.pageRef) return e.pageRef;
      for (const c of e.children) {
        const r = firstPageRef(c);
        if (r) return r;
      }
      return undefined;
    };

    for (const k of rootKids) visit(k, "StructTreeRoot", false);
    return sf;
  }

  private checkTable(
    table: { children: Obj[]; dict: Obj; type: string },
    sf: StructFacts,
    attr: (e: Obj, key: string) => Obj,
  ) {
    const rows: Obj[] = [];
    const collectRows = (e: Obj) => {
      for (const c of e.children) {
        if (c.type === "TR") rows.push(c);
        else if (["THead", "TBody", "TFoot"].includes(c.type)) collectRows(c);
      }
    };
    collectRows(table);

    let hasTH = false;
    const widths: number[] = [];
    const carry: number[] = []; // remaining rowspan per column
    for (const r of rows) {
      let col = 0;
      const occupied = new Set<number>();
      carry.forEach((n, i) => {
        if (n > 0) occupied.add(i);
      });
      for (const cell of r.children) {
        if (cell.type !== "TH" && cell.type !== "TD") continue;
        if (cell.type === "TH") hasTH = true;
        while (occupied.has(col)) col++;
        const cs = Math.max(1, this.num(attr(cell, "ColSpan")) ?? 1);
        const rs = Math.max(1, this.num(attr(cell, "RowSpan")) ?? 1);
        for (let i = 0; i < cs; i++) {
          occupied.add(col + i);
          if (rs > 1) carry[col + i] = Math.max(carry[col + i] ?? 0, rs);
        }
        col += cs;
      }
      widths.push(occupied.size === 0 ? 0 : Math.max(...occupied) + 1);
      for (let i = 0; i < carry.length; i++) if (carry[i] > 0) carry[i]--;
    }
    if (!hasTH) sf.tablesNoHeader++;
    const nonEmpty = widths.filter((w) => w > 0);
    if (nonEmpty.length > 1 && new Set(nonEmpty).size > 1) sf.irregularTables++;
    const summary = this.str(attr(table, "Summary"))?.trim() || this.str(this.get(table.dict, "Alt"))?.trim();
    if (!summary) sf.tablesNoSummary++;
  }
}

// ─────────────────────────────────────────────────────────────
// Content-stream scanner — tracks marked-content (BDC/BMC … EMC)
// nesting and counts painting operators outside any marked content.
// ─────────────────────────────────────────────────────────────
interface ScanResult {
  textOps: number;
  imageDos: number;
  untaggedText: number;
  untaggedXObject: number;
  untaggedPath: number;
}

const PATH_PAINT = new Set(["f", "F", "f*", "S", "s", "B", "B*", "b", "b*", "sh"]);
const TEXT_SHOW = new Set(["Tj", "TJ", "'", '"']);
const DELIMS = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);

function scanContent(src: string, xobjectSubtype: (name: string) => string | undefined): ScanResult {
  const r: ScanResult = { textOps: 0, imageDos: 0, untaggedText: 0, untaggedXObject: 0, untaggedPath: 0 };
  let depth = 0;
  let lastName: string | null = null;
  const n = src.length;
  let i = 0;
  const isWs = (c: string) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";

  while (i < n) {
    const c = src[i];
    if (isWs(c)) {
      i++;
      continue;
    }
    if (c === "%") {
      while (i < n && src[i] !== "\n" && src[i] !== "\r") i++;
      continue;
    }
    if (c === "(") {
      let lvl = 1;
      i++;
      while (i < n && lvl > 0) {
        const ch = src[i];
        if (ch === "\\") i += 2;
        else {
          if (ch === "(") lvl++;
          else if (ch === ")") lvl--;
          i++;
        }
      }
      continue;
    }
    if (c === "<") {
      if (src[i + 1] === "<") {
        i += 2;
        continue;
      }
      const end = src.indexOf(">", i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === ">" || c === "[" || c === "]" || c === "{" || c === "}" || c === ")") {
      i++;
      continue;
    }
    if (c === "/") {
      let j = i + 1;
      while (j < n && !isWs(src[j]) && !DELIMS.has(src[j])) j++;
      lastName = src.slice(i + 1, j);
      i = j;
      continue;
    }
    // regular token
    let j = i;
    while (j < n && !isWs(src[j]) && !DELIMS.has(src[j])) j++;
    const tok = src.slice(i, j);
    i = j === i ? i + 1 : j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok) || tok === "true" || tok === "false" || tok === "null") continue;

    switch (tok) {
      case "BDC":
      case "BMC":
        depth++;
        break;
      case "EMC":
        if (depth > 0) depth--;
        break;
      case "BI": {
        // inline image: skip binary data up to EI; counts as image
        const m = /\sEI(\s|$)/g;
        m.lastIndex = i;
        const found = m.exec(src);
        i = found ? found.index + 3 : n;
        r.imageDos++;
        if (depth === 0) r.untaggedXObject++;
        break;
      }
      case "Do": {
        const st = lastName ? xobjectSubtype(lastName) : undefined;
        if (st === "Image") r.imageDos++;
        if (depth === 0) r.untaggedXObject++;
        break;
      }
      default:
        if (TEXT_SHOW.has(tok)) {
          r.textOps++;
          if (depth === 0) r.untaggedText++;
        } else if (PATH_PAINT.has(tok)) {
          if (depth === 0) r.untaggedPath++;
        }
    }
    lastName = tok === "Do" ? null : lastName;
  }
  return r;
}

function bytesToLatin1(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)));
  }
  return s;
}

function decodeName(raw: string): string {
  const s = raw.startsWith("/") ? raw.slice(1) : raw;
  return s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// ─────────────────────────────────────────────────────────────
// Auto-fix — equivalent of Acrobat's "Fix" for auto-fixable rules
// ─────────────────────────────────────────────────────────────
export interface AutoFixOptions {
  /** Document title to set when missing (defaults to cleaned file name) */
  title?: string;
  /** BCP-47 language to set when missing (default "en-US") */
  lang?: string;
  fileName?: string;
}

export interface AutoFixResult {
  pdf: Uint8Array;
  applied: string[];
  manualRemaining: string[];
}

export async function autoFixPdfAccessibility(
  fileBuffer: Buffer | Uint8Array,
  opts: AutoFixOptions = {},
): Promise<AutoFixResult> {
  const lib = await import("pdf-lib");
  const doc = await lib.PDFDocument.load(fileBuffer, { ignoreEncryption: true, updateMetadata: false });
  if ((doc.context.trailerInfo as Obj).Encrypt) {
    throw new Error("Encrypted PDFs cannot be auto-fixed. Remove security first (File > Properties > Security > No Security).");
  }
  const ctx = new Ctx(lib, doc);
  const N = (s: string) => lib.PDFName.of(s);
  const catalog = doc.catalog;
  const applied: string[] = [];

  // Title (PDF-AC-06)
  let title: string | undefined;
  try {
    title = doc.getTitle()?.trim();
  } catch {
    title = undefined;
  }
  if (!title) {
    const t =
      opts.title?.trim() ||
      (opts.fileName || "Document").split(/[\\/]/).pop()!.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    doc.setTitle(t, { showInWindowTitleBar: true });
    applied.push(`Title set to "${t}" and shown in title bar`);
  } else if (ctx.bool(ctx.get(ctx.get(catalog, "ViewerPreferences"), "DisplayDocTitle")) !== true) {
    doc.setTitle(title, { showInWindowTitleBar: true });
    applied.push("Initial View set to show Document Title");
  }

  // Language (PDF-AC-05)
  if (!ctx.str(ctx.get(catalog, "Lang"))?.trim()) {
    const lang = opts.lang?.trim() || "en-US";
    doc.setLanguage(lang);
    applied.push(`Primary language set to ${lang}`);
  }

  // Tagged flag (PDF-AC-03 partial) — only when a structure tree exists
  const structRoot = ctx.get(catalog, "StructTreeRoot");
  if (structRoot && ctx.bool(ctx.get(ctx.get(catalog, "MarkInfo"), "Marked")) !== true) {
    catalog.set(N("MarkInfo"), doc.context.obj({ Marked: true }));
    applied.push("'Document is Tagged PDF' flag set (/MarkInfo /Marked true)");
  }

  // Tab order (PDF-AC-11)
  let tabFixed = 0;
  for (const p of doc.getPages()) {
    const node = p.node as Obj;
    const annots = ctx.arr(ctx.res(node.get(N("Annots"))));
    if (annots.length > 0 && ctx.name(ctx.res(node.get(N("Tabs")))) !== "S") {
      node.set(N("Tabs"), N("S"));
      tabFixed++;
    }
  }
  if (tabFixed) applied.push(`Tab order set to Use Document Structure on ${tabFixed} page(s)`);

  // Field descriptions (PDF-AC-19)
  let tuFixed = 0;
  try {
    for (const field of doc.getForm().getFields()) {
      const fd = (field as Obj).acroField.dict;
      if (!ctx.str(fd.get(N("TU")))?.trim()) {
        const human = field
          .getName()
          .split(".")
          .pop()!
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .replace(/[_\-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (human && !/^(field|text|check|radio|combo|list|button)\s*\d*$/i.test(human)) {
          fd.set(N("TU"), lib.PDFHexString.fromText(human));
          tuFixed++;
        }
      }
    }
  } catch {
    /* no AcroForm */
  }
  if (tuFixed) applied.push(`Tooltips (field descriptions) added to ${tuFixed} form field(s) from field names`);

  // Bookmarks from structure (PDF-AC-07)
  const outlines = ctx.get(catalog, "Outlines");
  if (!(outlines && ctx.get(outlines, "First")) && structRoot) {
    const idx = new Map<string, number>();
    doc.getPages().forEach((p, i) => idx.set(p.ref.toString(), i));
    const sf = (ctx as Obj).walkStructTree(structRoot, idx) as StructFacts;
    const targets = sf.headingTargets.filter((h) => h.pageRef);
    if (targets.length > 0) {
      const outlineRef = doc.context.nextRef();
      const itemRefs = targets.map(() => doc.context.nextRef());
      targets.forEach((h, i) => {
        const item: Record<string, Obj> = {
          Title: lib.PDFHexString.fromText(`${"  ".repeat(h.level - 1)}${h.title}`.trim()),
          Parent: outlineRef,
          Dest: doc.context.obj([h.pageRef, N("Fit")]),
        };
        if (i > 0) item.Prev = itemRefs[i - 1];
        if (i < targets.length - 1) item.Next = itemRefs[i + 1];
        doc.context.assign(itemRefs[i], doc.context.obj(item));
      });
      doc.context.assign(
        outlineRef,
        doc.context.obj({
          Type: "Outlines",
          First: itemRefs[0],
          Last: itemRefs[itemRefs.length - 1],
          Count: itemRefs.length,
        }),
      );
      catalog.set(N("Outlines"), outlineRef);
      applied.push(`${targets.length} bookmarks created from heading tags`);
    }
  }

  const pdf = await doc.save({ useObjectStreams: false });

  // Report what still needs a human (re-run checker on fixed output)
  const after = await runAcrobatProChecks(Buffer.from(pdf), opts.fileName || "document.pdf");
  const manualRemaining = (after.report?.rules || [])
    .filter((r) => r.status === "Failed" || r.status === "Needs Manual Check")
    .map((r) => `${r.category} › ${r.rule}: ${r.status}`);

  return { pdf, applied, manualRemaining };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
