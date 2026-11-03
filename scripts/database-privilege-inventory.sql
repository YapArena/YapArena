-- Read-only catalog evidence, PostgreSQL 17+. No rows, passwords, URLs, routine bodies,
-- arbitrary role settings, or provider secret/configuration tables are exported.
WITH
schemas AS (
  SELECT * FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
),
identities AS (
  SELECT * FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','authenticator','yaparena_runtime','yaparena_encoder','yaparena_owner')
),
relations AS (
  SELECT c.*, n.nspname FROM pg_class c JOIN schemas n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','S','f')
),
routines AS (
  SELECT p.*, n.nspname FROM pg_proc p JOIN schemas n ON n.oid = p.pronamespace
),
creators AS (
  SELECT nspowner AS oid FROM schemas UNION SELECT relowner FROM relations
  UNION SELECT proowner FROM routines UNION SELECT defaclrole FROM pg_default_acl
),
evidence AS (
  SELECT 'context' AS section, jsonb_build_object('database', current_database(),
    'inspectionRole', current_user, 'serverVersion', current_setting('server_version'),
    'date', CURRENT_TIMESTAMP, 'hostedApiSettings', 'not established by SQL inventory') AS item
  UNION ALL
  SELECT 'roles', jsonb_build_object('name', rolname, 'superuser', rolsuper,
    'bypassRls', rolbypassrls, 'createDb', rolcreatedb, 'createRole', rolcreaterole,
    'replication', rolreplication, 'inherit', rolinherit, 'login', rolcanlogin)
    FROM pg_roles
  UNION ALL
  SELECT 'memberships', jsonb_build_object('role', pg_get_userbyid(roleid),
    'member', pg_get_userbyid(member), 'grantor', pg_get_userbyid(grantor),
    'admin', admin_option, 'inherit', inherit_option, 'set', set_option) FROM pg_auth_members
  UNION ALL
  SELECT 'effectiveMemberships', jsonb_build_object('identity', i.rolname, 'role', r.rolname,
    'member', pg_has_role(i.oid,r.oid,'MEMBER'), 'inherit', pg_has_role(i.oid,r.oid,'USAGE'),
    'set', pg_has_role(i.oid,r.oid,'SET')) FROM identities i CROSS JOIN pg_roles r
    WHERE i.oid <> r.oid AND pg_has_role(i.oid,r.oid,'MEMBER')
  UNION ALL
  SELECT 'databasePrivileges',jsonb_build_object('database',d.datname,'owner',pg_get_userbyid(d.datdba),
    'acl',COALESCE(d.datacl,acldefault('d',d.datdba))::text,'identity',i.rolname,
    'connect',has_database_privilege(i.oid,d.oid,'CONNECT'),'create',has_database_privilege(i.oid,d.oid,'CREATE'),
    'temporary',has_database_privilege(i.oid,d.oid,'TEMPORARY')) FROM pg_database d CROSS JOIN identities i
    WHERE d.datname=current_database()
  UNION ALL
  SELECT 'ownership',jsonb_build_object('role',pg_get_userbyid(s.refobjid),'catalog',s.classid::regclass::text,
    'objectOid',s.objid,'subobject',s.objsubid) FROM pg_shdepend s
    WHERE s.refclassid='pg_authid'::regclass AND s.deptype='o'
      AND s.dbid IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))
  UNION ALL
  SELECT 'schemas', jsonb_build_object('schema', nspname, 'owner', pg_get_userbyid(nspowner),
    'acl', COALESCE(nspacl, acldefault('n',nspowner))::text) FROM schemas
  UNION ALL
  SELECT 'effectiveSchemas', jsonb_build_object('identity', i.rolname, 'schema', n.nspname,
    'usage', has_schema_privilege(i.oid,n.oid,'USAGE'), 'create', has_schema_privilege(i.oid,n.oid,'CREATE'))
    FROM identities i CROSS JOIN schemas n
  UNION ALL
  SELECT 'relations', jsonb_build_object('schema', nspname, 'name', relname, 'kind', relkind,
    'owner', pg_get_userbyid(relowner), 'acl', COALESCE(relacl, acldefault(CASE WHEN relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,relowner))::text,
    'rls', relrowsecurity, 'forceRls', relforcerowsecurity, 'viewOptions', reloptions)
    FROM relations
  UNION ALL
  SELECT 'columns', jsonb_build_object('schema', r.nspname,'relation',r.relname,'column',a.attname,'acl',a.attacl::text)
    FROM pg_attribute a JOIN relations r ON r.oid=a.attrelid WHERE a.attacl IS NOT NULL AND a.attnum>0
  UNION ALL
  SELECT 'effectiveRelations', jsonb_build_object('identity',i.rolname,'schema',r.nspname,'name',r.relname,
    'privileges', jsonb_build_object('select',has_table_privilege(i.oid,r.oid,'SELECT'),
    'insert',has_table_privilege(i.oid,r.oid,'INSERT'),'update',has_table_privilege(i.oid,r.oid,'UPDATE'),
    'delete',has_table_privilege(i.oid,r.oid,'DELETE'),'truncate',has_table_privilege(i.oid,r.oid,'TRUNCATE'),
    'references',has_table_privilege(i.oid,r.oid,'REFERENCES'),'trigger',has_table_privilege(i.oid,r.oid,'TRIGGER'),
    'columnSelect',has_any_column_privilege(i.oid,r.oid,'SELECT'),
    'columnInsert',has_any_column_privilege(i.oid,r.oid,'INSERT'),'columnUpdate',has_any_column_privilege(i.oid,r.oid,'UPDATE')))
    FROM identities i CROSS JOIN relations r WHERE r.relkind <> 'S'
  UNION ALL
  SELECT 'effectiveSequences', jsonb_build_object('identity',i.rolname,'schema',r.nspname,'name',r.relname,
    'usage',has_sequence_privilege(i.oid,r.oid,'USAGE'),'select',has_sequence_privilege(i.oid,r.oid,'SELECT'),
    'update',has_sequence_privilege(i.oid,r.oid,'UPDATE')) FROM identities i CROSS JOIN relations r WHERE r.relkind='S'
  UNION ALL
  SELECT 'policies', jsonb_build_object('schema',n.nspname,'table',c.relname,'name',p.polname,
    'permissive',p.polpermissive,'command',p.polcmd,'roles',
    (SELECT jsonb_agg(CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x) END) FROM unnest(p.polroles) x),
    'using',regexp_replace(pg_get_expr(p.polqual,p.polrelid), '''([^'']|'''')*''', '''[literal]''','g'),
    'check',regexp_replace(pg_get_expr(p.polwithcheck,p.polrelid), '''([^'']|'''')*''', '''[literal]''','g'))
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN schemas n ON n.oid=c.relnamespace
  UNION ALL
  SELECT 'routines', jsonb_build_object('schema',nspname,'name',proname,'identityArguments',pg_get_function_identity_arguments(oid),
    'kind',prokind,'owner',pg_get_userbyid(proowner),'securityDefiner',prosecdef,'bodyHash',md5(prosrc),
    'searchPath',(SELECT x FROM unnest(proconfig) x WHERE x LIKE 'search_path=%' LIMIT 1),
    'acl',COALESCE(proacl,acldefault('f',proowner))::text) FROM routines
  UNION ALL
  SELECT 'effectiveRoutines', jsonb_build_object('identity',i.rolname,'schema',p.nspname,'routine',p.proname,
    'identityArguments',pg_get_function_identity_arguments(p.oid),'execute',has_function_privilege(i.oid,p.oid,'EXECUTE'))
    FROM identities i CROSS JOIN routines p
  UNION ALL
  SELECT 'viewDependencies',jsonb_build_object('viewSchema',vn.nspname,'view',v.relname,'targetSchema',tn.nspname,'target',t.relname)
    FROM pg_depend d JOIN pg_rewrite rw ON rw.oid=d.objid AND d.classid='pg_rewrite'::regclass
    JOIN pg_class v ON v.oid=rw.ev_class JOIN schemas vn ON vn.oid=v.relnamespace
    JOIN pg_class t ON t.oid=d.refobjid AND d.refclassid='pg_class'::regclass
    JOIN schemas tn ON tn.oid=t.relnamespace WHERE v.oid<>t.oid
  UNION ALL
  SELECT 'routineDependencies', jsonb_build_object('schema',p.nspname,'routine',p.proname,'targetSchema',n.nspname,'target',c.relname)
    FROM pg_depend d JOIN routines p ON p.oid=d.objid AND d.classid='pg_proc'::regclass
    JOIN pg_class c ON c.oid=d.refobjid AND d.refclassid='pg_class'::regclass JOIN schemas n ON n.oid=c.relnamespace
  UNION ALL
  SELECT 'defaultPrivileges', jsonb_build_object('creator',pg_get_userbyid(d.defaclrole),
    'schema',COALESCE(n.nspname,'[global]'),'kind',d.defaclobjtype,'acl',d.defaclacl::text)
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
  UNION ALL
  SELECT 'creatorBaseDefaults',jsonb_build_object('creator',pg_get_userbyid(c.oid),'kind',k,
    'acl',COALESCE(d.defaclacl,acldefault(k,c.oid))::text) FROM creators c
    CROSS JOIN unnest(ARRAY['r','s','f','n','T']::"char"[]) k
    LEFT JOIN pg_default_acl d ON d.defaclrole=c.oid AND d.defaclnamespace=0 AND d.defaclobjtype=k
  UNION ALL
  SELECT 'publications',jsonb_build_object('name',p.pubname,'allTables',p.puballtables,
    'schema',n.nspname,'table',c.relname) FROM pg_publication p
    LEFT JOIN pg_publication_rel pr ON pr.prpubid=p.oid LEFT JOIN pg_class c ON c.oid=pr.prrelid
    LEFT JOIN pg_namespace n ON n.oid=c.relnamespace
  UNION ALL
  SELECT 'extensions',jsonb_build_object('name',e.extname,'schema',n.nspname,'version',e.extversion)
    FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
)
SELECT section, jsonb_agg(item ORDER BY item::text) AS evidence FROM evidence GROUP BY section ORDER BY section;
