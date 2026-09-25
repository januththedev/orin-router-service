DO $$ BEGIN
  IF to_regclass('public.router_providers') IS NOT NULL THEN ALTER TABLE public.router_providers RENAME TO legacy_router_providers; END IF;
  IF to_regclass('public.router_keys') IS NOT NULL THEN ALTER TABLE public.router_keys RENAME TO legacy_router_keys; END IF;
  IF to_regclass('public.router_logs') IS NOT NULL THEN ALTER TABLE public.router_logs RENAME TO legacy_router_logs; END IF;
END $$;
REVOKE ALL ON public.legacy_router_providers FROM PUBLIC;
REVOKE ALL ON public.legacy_router_keys FROM PUBLIC;
REVOKE ALL ON public.legacy_router_logs FROM PUBLIC;
