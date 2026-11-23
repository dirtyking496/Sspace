-- SSPACE: strict authorization for call_signals INSERT.
drop policy if exists "Send own call signals" on public.call_signals;
create policy "Send own call signals"
  on public.call_signals for insert to authenticated
  with check (
    (select auth.uid()) = sender_id
    and sender_id <> receiver_id
    and exists (
      select 1 from public.friend_requests fr
      where fr.status = 'accepted'
        and ((fr.sender_id = sender_id and fr.receiver_id = receiver_id)
          or (fr.sender_id = receiver_id and fr.receiver_id = sender_id))
    )
  );
