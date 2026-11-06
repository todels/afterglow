-- Afterglow share links. Run once in the Supabase SQL editor (Dashboard > SQL Editor > New query).
-- Replace you@example.com (4 places) with the email you sign in with. Only that login can upload or delete;
-- anyone with a link can read that link's files by their exact path, but nobody else can list them.

insert into storage.buckets (id, name, public, file_size_limit)
values ('afterglow', 'afterglow', true, 52428800) -- 50 MB per file, the free plan's maximum
on conflict (id) do update set public = true;

create policy "afterglow: owner lists" on storage.objects for select to authenticated
  using (bucket_id = 'afterglow' and (auth.jwt() ->> 'email') = 'you@example.com');
create policy "afterglow: owner uploads" on storage.objects for insert to authenticated
  with check (bucket_id = 'afterglow' and (auth.jwt() ->> 'email') = 'you@example.com');
create policy "afterglow: owner updates" on storage.objects for update to authenticated
  using (bucket_id = 'afterglow' and (auth.jwt() ->> 'email') = 'you@example.com')
  with check (bucket_id = 'afterglow');
create policy "afterglow: owner deletes" on storage.objects for delete to authenticated
  using (bucket_id = 'afterglow' and (auth.jwt() ->> 'email') = 'you@example.com');
