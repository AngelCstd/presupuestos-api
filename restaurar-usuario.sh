#!/bin/bash
docker exec presupuestos-db-test-1 psql -U postgres -d budget_test -c "INSERT INTO auth.users (id) VALUES ('e68fcf27-7fe4-4944-bb42-0eac5da720a5') ON CONFLICT DO NOTHING;"
