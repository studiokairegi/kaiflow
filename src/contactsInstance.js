import { supabase } from "./supabaseClient";
import { makeContactsApi } from "./contactsApi.js";

export const contactsApi = makeContactsApi(supabase);
