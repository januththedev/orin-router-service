INSERT INTO orin_router.router_aliases(alias) VALUES ('orin-cheap'), ('orin-balanced'), ('orin-thinking'), ('orin-coding') ON CONFLICT (alias) DO NOTHING;
