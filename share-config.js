// Supabase project that stores share links (README: Share links). The publishable / anon key is meant to be
// public: uploads still need your Supabase login, and the bucket only serves files by their exact path.
export const SHARE = { url: '', key: '', bucket: 'afterglow' };

// GitHub repo that stores share links (?t=). Public, but every file in it is encrypted; the key is only in the link.
export const GH_SHARE = { repo: 'todels/afterglow-shares' };
