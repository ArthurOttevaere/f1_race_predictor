-- 0011 — How the field did against the model, per race, in one row.
--
-- The standings' race list, the race page header and the weekend card on /game
-- all want the same three numbers for a Grand Prix: how many players entered,
-- how many beat the model, how many drew. Counting them client-side means
-- reading every score of the season, which is players × races rows and runs
-- into the 1000-row cap (supabase/README.md) at fifty players. One aggregate,
-- computed where the rows live.
--
-- `scores` is public-read, so this is `security invoker`: it grants nothing
-- the anon key could not already read, it only counts it.

create or replace function public.race_field_summary(p_season integer)
returns table (race_id bigint, players integer, beat integer, drew integer)
language sql stable security invoker set search_path = public
as $$
  select s.race_id,
         count(*)::integer                              as players,
         count(*) filter (where s.beat_model)::integer  as beat,
         count(*) filter (where s.drew_model)::integer  as drew
    from public.scores s
    join public.races r on r.id = s.race_id
   where r.season = p_season
   group by s.race_id;
$$;

grant execute on function public.race_field_summary(integer) to anon, authenticated, service_role;
