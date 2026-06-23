const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || "";
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || "";

const isSupabaseReady = Boolean(url && anonKey && url.includes("supabase.co"));

const supabase = isSupabaseReady ? createClient(url, anonKey) : null;

module.exports = {
  supabase,
  isSupabaseReady,
};
