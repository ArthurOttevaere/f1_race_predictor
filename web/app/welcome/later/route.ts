import { NextResponse } from "next/server";
import { PICKS_LATER_COOKIE, safePath } from "@/lib/auth";

/**
 * "Later" on the championship-call step of /welcome.
 *
 * A POST, not a link: a GET that changed state would be prefetched by the
 * browser hovering over it. It sets the thirty-day cookie `needsPicksPrompt`
 * reads and sends the player where they were going.
 */
export async function POST(request: Request) {
  const form = await request.formData();
  const next = safePath(String(form.get("next") ?? ""));
  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.cookies.set(PICKS_LATER_COOKIE, "1", {
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
    sameSite: "lax",
    httpOnly: true,
  });
  return response;
}
