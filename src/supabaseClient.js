import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // createClient() throws synchronously on a bad URL, and this file runs
  // at module-import time - before React ever mounts - so an uncaught
  // throw here kills the entire script with nothing rendered: a real
  // blank #root with no error visible anywhere but the console. Failing
  // loud with a message actually in the page (not just console.error)
  // turns "the site is mysteriously blank" into "it's obviously a missing
  // config problem" the moment it happens, instead of requiring a
  // DevTools session to even discover there's an error at all.
  document.body.innerHTML =
    '<div style="font-family: sans-serif; padding: 40px; color: #333;">' +
    "<h2>Configuration error</h2>" +
    "<p>Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. " +
    "Check this deployment's environment variables and rebuild.</p>" +
    "</div>";
  throw new Error(
    "Missing Supabase env vars. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
export const SUPABASE_URL = supabaseUrl;
export const functionUrl = (name) => `${supabaseUrl}/functions/v1/${name}`;
