
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  console.warn('Supabase environment variables are missing.');
}

export const supabase = createClient(
  supabaseUrl || 'https://example.supabase.co',
  supabasePublishableKey || 'missing-publishable-key'
);

export const auth = {
  async getUser() {
    const { data, error } = await supabase.auth.getUser();

    if (error && error.name !== 'AuthSessionMissingError') {
      throw error;
    }

    const user = data.user;

    if (!user) return null;

    return {
      userId: user.id,
      email: user.email,
      name:
        user.user_metadata?.full_name ||
        user.user_metadata?.name ||
        user.email,
    };
  },

  async signInWithRedirect() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
      },
    });

    if (error) throw error;
  },

  async signOut() {
    const { error } = await supabase.auth.signOut();

    if (error) throw error;
  },
};

