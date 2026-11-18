import { NextRequest, NextResponse } from "next/server";
import { autoFixPdfAccessibility } from "@/lib/engines/pdf-acrobat-checker";

export const dynamic = "force-dynamic";

/**
 * POST /api/audit/pdf/autofix  (add-on, Acrobat-style "Fix")
 * form-data: file (PDF, required), title (optional), lang (optional, e.g. en-US)
 * Returns the fixed PDF. Header X-Fixes-Applied / X-Manual-Remaining carry
 * URI-encoded JSON arrays describing what was fixed and what still needs a human.
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "PDF file is required" }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json({ error: "Only PDF files are accepted" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const title = (formData.get("title") as string | null) || undefined;
    const lang = (formData.get("lang") as string | null) || undefined;

    const result = await autoFixPdfAccessibility(buffer, {
      title,
      lang,
      fileName: file.name,
    });

    const outName = file.name.replace(/\.pdf$/i, "") + "-accessible.pdf";
    return new NextResponse(Buffer.from(result.pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(outName)}"`,
        "X-Fixes-Applied": encodeURIComponent(JSON.stringify(result.applied)),
        "X-Manual-Remaining": encodeURIComponent(JSON.stringify(result.manualRemaining)),
        "Access-Control-Expose-Headers": "X-Fixes-Applied, X-Manual-Remaining",
      },
    });
  } catch (error) {
    console.error("PDF auto-fix error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to auto-fix PDF" },
      { status: 500 },
    );
  }
}
