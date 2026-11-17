PRAGMA foreign_keys = ON;
BEGIN;
CREATE TABLE patient (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT 1
);
CREATE TABLE visit (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patient(id),
  occurred_on DATE NOT NULL,
  cost DECIMAL(10,2),
  note TEXT
);
CREATE INDEX visit_patient ON visit(patient_id);
CREATE VIEW visit_totals AS
  SELECT patient_id, COUNT(*) AS visit_count, SUM(cost) AS total_cost
  FROM visit GROUP BY patient_id;
INSERT INTO patient VALUES (1, 'Example One', 1), (2, 'Example Two', 0);
INSERT INTO visit VALUES
  (10, 1, '2026-01-10', 40.50, 'Synthetic visit'),
  (11, 1, '2026-02-20', 20.00, NULL),
  (12, 2, '2026-03-01', 15.00, NULL);
COMMIT;
