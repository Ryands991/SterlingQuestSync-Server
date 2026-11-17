-- Which Companion app version each PC last used, from its User-Agent ("SterlingQuestSync/0.1.25").
-- Not personal: it only lets the owner see how many installs are on each version. NULL until seen.
ALTER TABLE keys ADD COLUMN app_version TEXT;
