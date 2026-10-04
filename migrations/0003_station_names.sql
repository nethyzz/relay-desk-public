ALTER TABLE endpoints ADD COLUMN station_name TEXT NOT NULL DEFAULT '';

-- Same-URL Key profiles share a relay name while keeping their own names and groups.
UPDATE endpoints SET station_name = (
  SELECT source.name FROM endpoints AS source
  WHERE source.base_url = endpoints.base_url
  ORDER BY source.created_at, source.id LIMIT 1
);
