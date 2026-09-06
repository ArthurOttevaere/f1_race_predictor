-- 0012 — The last few duels of each player on a standings page.
--
-- The board ranks on the duel record, and a record without a shape hides the
-- thing everyone actually wants to know: is this player on a run? Five
-- markers per row answer it. Reading them client-side would mean pulling
-- every score of every listed player — a hundred players by two dozen races
-- is past PostgREST's 1000-row cap (supabase/README.md) — so the window
-- function runs where the rows live and only the last five come back.
--
-- `scores` is public-read, so this is `security invoker`: it grants nothing
-- the anon key could not already read, it only narrows it.

create or replace function public.player_form(
  p_season   integer,
  p_user_ids uuid[],
  p_races    integer default 5
)
returns table (user_id uuid, round integer, name text, outcome text)
language sql stable security invoker set search_path = public
as $$
  select f.user_id, f.round, f.name, f.outcome
    from (
      select s.user_id,
             r.round,
             r.name,
             case when s.beat_model then 'W'
                  when s.drew_model then 'D'
                  else 'L' end                                as outcome,
             row_number() over (partition by s.user_id
                                    order by r.round desc)    as rn
        from public.scores s
        join public.races r on r.id = s.race_id
       where r.season = p_season
         and s.user_id = any(p_user_ids)
    ) f
   where f.rn <= greatest(p_races, 1)
   -- Oldest first, so a row reads left to right the way the season ran.
   order by f.user_id, f.round;
$$;

grant execute on function public.player_form(integer, uuid[], integer)
  to anon, authenticated, service_role;
