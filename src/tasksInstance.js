import { supabase } from "./supabaseClient";
import { makeTasksApi } from "./tasksApi.js";

export const tasksApi = makeTasksApi(supabase);
