-- Campaigns imported from Meta before the fix got "1970-01-01" for "no start date".
update campaigns set start_date = '' where start_date <> '' and start_date < '2000-01-01';
update campaigns set end_date = '' where end_date <> '' and end_date < '2000-01-01';
