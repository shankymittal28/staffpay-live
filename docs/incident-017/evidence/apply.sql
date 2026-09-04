begin;
select set_config('request.jwt.claims','{"sub":"b96b7056-f8da-491b-ba3c-558d620c5010","role":"authenticated"}',true);
set local role authenticated;

insert into staff_employee (legacy_id,name,work_group,phone,active,salary,wage_type,opening_balance,source,removed,device) values
('stf_abdul','Abdul','shop','',true,300,'daily',0,'staff',false,'recovery-017'),
('stf_arjun','Arjun','shop','',true,500,'daily',0,'staff',false,'recovery-017'),
('stf_bablu','Bablu','shop','',true,300,'daily',0,'staff',false,'recovery-017'),
('stf_bhunu','Bhunu','shop','',true,300,'daily',0,'staff',false,'recovery-017'),
('stf_chandrabhan','Chandrabhan','workshop','',true,400,'daily',0,'staff',false,'recovery-017'),
('stf_chandu','Chandu','workshop','',true,500,'daily',0,'staff',false,'recovery-017'),
('stf_chottu','Chottu','shop','',true,700,'daily',0,'staff',false,'recovery-017'),
('stf_deepak','Deepak','shop','',true,300,'daily',0,'staff',false,'recovery-017'),
('stf_devendra','Devendra','workshop','',true,750,'daily',0,'staff',false,'recovery-017'),
('stf_dharam','Dharam','shop','',true,400,'daily',0,'staff',false,'recovery-017'),
('stf_ganpat','Ganpat','shop','',true,500,'daily',0,'staff',false,'recovery-017'),
('stf_ikrar','Ikrar','shop','',true,1000,'daily',0,'staff',false,'recovery-017'),
('stf_kapil','Kapil','shop','',true,500,'daily',0,'staff',false,'recovery-017'),
('stf_khem','Khem','shop','',true,450,'daily',0,'staff',false,'recovery-017'),
('stf_krish','Krish','shop','',true,250,'daily',0,'staff',false,'recovery-017'),
('stf_lakeshwar','Lakeshwar','workshop','',true,930,'daily',0,'staff',false,'recovery-017'),
('stf_laxman','Laxman','workshop','',true,1000,'daily',0,'staff',false,'recovery-017'),
('stf_lokesh','Lokesh','workshop','',true,500,'daily',0,'staff',false,'recovery-017'),
('stf_mahindra','Mahindra','workshop','',true,150,'daily',0,'staff',false,'recovery-017'),
('stf_nandu','Nandu','workshop','',true,300,'daily',0,'staff',false,'recovery-017'),
('stf_naveen','Naveen','shop','',true,400,'daily',0,'staff',false,'recovery-017'),
('stf_raj_swarnkar','Raj swarnkar','shop','',true,24000,'monthly',0,'staff',false,'recovery-017'),
('stf_rohit','Rohit','workshop','',true,400,'daily',0,'staff',false,'recovery-017'),
('stf_sahil','Sahil','workshop','',true,100,'daily',0,'staff',false,'recovery-017'),
('stf_santosh','Santosh','shop','',true,500,'daily',0,'staff',false,'recovery-017'),
('stf_sonsaye','Sonsaye','shop','',true,300,'daily',0,'staff',false,'recovery-017'),
('stf_tushar','Tushar','shop','',true,300,'daily',0,'staff',false,'recovery-017'),
('stf_vishal_yadav','Vishal yadav','shop','',true,500,'daily',0,'staff',false,'recovery-017')
on conflict (owner_id,legacy_id) do update set name=excluded.name,work_group=excluded.work_group,phone=excluded.phone,active=excluded.active,salary=excluded.salary,wage_type=excluded.wage_type,opening_balance=excluded.opening_balance,source=excluded.source,removed=excluded.removed,device=excluded.device;

do $$ begin if (select count(*) from staff_employee) <> 28 then raise exception 'CHECKPOINT: staff count % <> 28', (select count(*) from staff_employee); end if; end $$;

insert into staff_attendance (legacy_id,staff_id,name,status,note,date,month_key,day_key,device) values
('1788006866627',null,'Chandrabhan','Absent','','2026-08-29T12:34:26.000Z','2026-08','2026-08-29','web-Mozilla/5.0 (Linux; '),
('1788006868170',null,'Chandu','Absent','','2026-08-29T12:34:28.000Z','2026-08','2026-08-29','web-Mozilla/5.0 (Linux; '),
('1788006869323',null,'Devendra','Present','','2026-08-29T12:34:29.000Z','2026-08','2026-08-29','web-Mozilla/5.0 (Linux; '),
('1788006870851',null,'Lakeshwar','Present','','2026-08-29T12:34:30.000Z','2026-08','2026-08-29','web-Mozilla/5.0 (Linux; '),
('1788006872703',null,'Laxman','Absent','','2026-08-29T12:34:32.000Z','2026-08','2026-08-29','web-Mozilla/5.0 (Linux; '),
('1788006874126',null,'Lokesh','Absent','','2026-08-29T12:34:34.000Z','2026-08','2026-08-29','web-Mozilla/5.0 (Linux; '),
('1788006875541',null,'Mahindra','Present','','2026-08-29T12:34:35.000Z','2026-08','2026-08-29','web-Mozilla/5.0 (Linux; '),
('1788006876711',null,'Nandu','Present','','2026-08-29T12:34:36.000Z','2026-08','2026-08-29','web-Mozilla/5.0 (Linux; '),
('1788006877955',null,'Rohit','Absent','','2026-08-29T12:34:37.000Z','2026-08','2026-08-29','web-Mozilla/5.0 (Linux; '),
('1788006879251',null,'Sahil','Absent','','2026-08-29T12:34:39.000Z','2026-08','2026-08-29','web-Mozilla/5.0 (Linux; ')
on conflict (owner_id,legacy_id) do update set staff_id=excluded.staff_id,name=excluded.name,status=excluded.status,note=excluded.note,date=excluded.date,month_key=excluded.month_key,day_key=excluded.day_key,device=excluded.device;

do $$ begin if (select count(*) from staff_attendance) <> 10 then raise exception 'CHECKPOINT: attendance count % <> 10', (select count(*) from staff_attendance); end if; end $$;

commit;
