INSERT INTO public.facilities (source_id, name, address, permit_type, last_inspection_score, raw, google_places) VALUES
('pin', 'Peachtree Example', 'Atlanta, GA', 'Restaurant', 92, '{}', 'https://maps.example/!3d33.749!4d-84.388?viewport=34,-85'),
('zero', 'Zero Example', 'Macon, GA', 'Restaurant', 0, '{}', 'https://maps.example/!3d32.84!4d-83.63'),
('missing', 'Missing Location Example', 'Georgia', 'Food Service', NULL, '{}', NULL),
('invalid', 'Invalid Location Example', 'Georgia', NULL, NULL, '{}', 'https://maps.example/!3d999!4d999');
INSERT INTO public.inspections (facility_id, source_id, report_template, inspection_date, score, raw, violations_hash) VALUES
('pin', 1, 'example', '2025-01-01', 85, '{}', 'old'),
('pin', 2, 'example', '2025-02-01', 92, '{}', 'current'),
('zero', 3, 'example', '2025-02-02', 0, '{}', 'zero');
INSERT INTO public.violations (facility_id, inspection_id, snapshot_hash, source_key, code_title, raw) VALUES
('pin', 1, 'old', '1', 'Example historical violation', '{}'),
('pin', 2, 'current', '1', 'Example current violation', '{}'),
('pin', 2, 'stale', '2', 'Example superseded violation', '{}');
INSERT INTO public.etl_runs (started, finished, status, options, next_page) VALUES
('2025-01-01', '2025-01-01 01:00Z', 'exhausted', '{}', 1),
('2025-02-01', '2025-02-01 01:00Z', 'caught_up', '{}', 1),
('2025-03-01', NULL, 'running', '{}', 2),
('2025-04-01', '2025-04-01 01:00Z', 'failed', '{}', 2);
