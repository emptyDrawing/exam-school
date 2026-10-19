-- =====================================================================
-- 평가 시스템 DB (Supabase)
-- Supabase 대시보드 > SQL Editor 에 이 파일 전체를 붙여 넣고 [Run].
-- 마지막 줄의 교사 이메일만 본인 Gmail 로 바꾸세요.
--
-- 원칙
--  - 학생은 테이블에 직접 접근할 수 없고, 아래 4개 함수만 호출할 수 있다.
--    my_status / register_student / start_exam / submit_exam
--  - 정답(questions.answer)은 DB 밖으로 나가지 않는다. 채점도 DB 안에서 한다.
--  - 교사(teachers 테이블에 등록된 이메일)는 모든 테이블을 읽고 쓸 수 있다.
-- =====================================================================

-- ---------- 테이블 ----------

create table if not exists public.teachers (
  email text primary key
);

create table if not exists public.exams (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  starts_at         timestamptz,                 -- 비우면 제한 없음
  ends_at           timestamptz,                 -- 비우면 제한 없음
  max_attempts      int  not null default 1 check (max_attempts >= 1),
  reveal            text not null default 'score'
                    check (reveal in ('none', 'score', 'detail')),  -- 제출 후 학생에게 보여줄 것
  shuffle_questions boolean not null default false,
  shuffle_options   boolean not null default false,
  is_open           boolean not null default false,               -- 학생 목록에 보이는지
  created_at        timestamptz not null default now()
);

create table if not exists public.questions (
  id      uuid primary key default gen_random_uuid(),
  exam_id uuid not null references public.exams(id) on delete cascade,
  num     int  not null,
  kind    text not null default 'choice' check (kind in ('choice', 'short')),
  prompt  text not null,
  opt1 text, opt2 text, opt3 text, opt4 text, opt5 text,
  answer  text not null,      -- 객관식: 정답 보기 번호(예: 3, 복수정답 2|4) / 단답형: 정답(여러 개는 | 로 구분)
  points  numeric not null default 1 check (points >= 0),
  unique (exam_id, num)
);

create table if not exists public.students (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  class_no   int  not null,
  student_no int  not null,
  approved   boolean not null default false,
  created_at timestamptz not null default now(),
  unique (class_no, student_no)
);

create table if not exists public.submissions (
  id           bigint generated always as identity primary key,
  exam_id      uuid not null references public.exams(id) on delete cascade,
  user_id      uuid not null references public.students(user_id) on delete cascade,
  attempt      int  not null,
  score        numeric not null,
  total        numeric not null,
  answers      jsonb not null,   -- { 문항id: 학생 답 }
  detail       jsonb not null,   -- [ { num, ok, points } ]
  submitted_at timestamptz not null default now(),
  unique (exam_id, user_id, attempt)
);

-- ---------- 권한: 교사만 테이블 직접 접근 ----------

create or replace function public.is_teacher()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from teachers where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

alter table public.teachers    enable row level security;
alter table public.exams       enable row level security;
alter table public.questions   enable row level security;
alter table public.students    enable row level security;
alter table public.submissions enable row level security;

drop policy if exists teacher_all on public.teachers;
drop policy if exists teacher_all on public.exams;
drop policy if exists teacher_all on public.questions;
drop policy if exists teacher_all on public.students;
drop policy if exists teacher_all on public.submissions;

create policy teacher_all on public.teachers    for all to authenticated using (public.is_teacher()) with check (public.is_teacher());
create policy teacher_all on public.exams       for all to authenticated using (public.is_teacher()) with check (public.is_teacher());
create policy teacher_all on public.questions   for all to authenticated using (public.is_teacher()) with check (public.is_teacher());
create policy teacher_all on public.students    for all to authenticated using (public.is_teacher()) with check (public.is_teacher());
create policy teacher_all on public.submissions for all to authenticated using (public.is_teacher()) with check (public.is_teacher());

-- ---------- 내부 도우미 ----------

create or replace function public._norm(t text)
returns text
language sql immutable
as $$
  select lower(regexp_replace(coalesce(t, ''), '\s+', '', 'g'));
$$;

-- 로그인 + 등록 + 승인된 학생인지 확인하고 학생 행을 돌려준다.
create or replace function public._require_student()
returns public.students
language plpgsql stable security definer set search_path = public
as $$
declare
  v_s students;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.';
  end if;
  select * into v_s from students where user_id = auth.uid();
  if not found then
    raise exception '먼저 반과 번호를 등록해 주세요.';
  end if;
  if not v_s.approved then
    raise exception '선생님의 승인을 기다리는 중입니다.';
  end if;
  return v_s;
end;
$$;

-- ---------- 학생용 함수 ----------

-- 내 등록 상태와 응시 가능한 시험 목록
create or replace function public.my_status()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_s     students;
  v_exams jsonb;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.';
  end if;

  select * into v_s from students where user_id = auth.uid();
  if not found then
    return jsonb_build_object(
      'email', auth.jwt() ->> 'email',
      'registered', false,
      'is_teacher', is_teacher());
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id,
           'title', e.title,
           'starts_at', e.starts_at,
           'ends_at', e.ends_at,
           'max_attempts', e.max_attempts,
           'used', (select count(*) from submissions x
                     where x.exam_id = e.id and x.user_id = v_s.user_id),
           'state', case
                      when e.starts_at is not null and now() < e.starts_at then 'before'
                      when e.ends_at   is not null and now() > e.ends_at   then 'after'
                      else 'open' end
         ) order by e.created_at desc), '[]'::jsonb)
    into v_exams
    from exams e
   where e.is_open and v_s.approved;

  return jsonb_build_object(
    'email', v_s.email,
    'registered', true,
    'approved', v_s.approved,
    'class_no', v_s.class_no,
    'student_no', v_s.student_no,
    'exams', v_exams,
    'is_teacher', is_teacher());
end;
$$;

-- 처음 로그인한 학생이 반·번호를 등록 (교사가 승인해야 응시 가능)
create or replace function public.register_student(p_class int, p_no int)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.';
  end if;
  if p_class is null or p_no is null
     or p_class not between 1 and 30 or p_no not between 1 and 60 then
    raise exception '반과 번호를 다시 확인해 주세요.';
  end if;
  if exists (select 1 from students where user_id = auth.uid()) then
    raise exception '이미 등록한 계정입니다.';
  end if;

  begin
    insert into students (user_id, email, class_no, student_no)
    values (auth.uid(), lower(coalesce(auth.jwt() ->> 'email', '')), p_class, p_no);
  exception when unique_violation then
    raise exception '%반 %번은 이미 다른 계정으로 등록되어 있습니다. 선생님께 알려 주세요.', p_class, p_no;
  end;

  return my_status();
end;
$$;

-- 시험 시작: 문제를 돌려준다 (정답은 절대 포함하지 않음)
create or replace function public.start_exam(p_exam uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_s    students;
  v_e    exams;
  v_used int;
  v_qs   jsonb;
begin
  v_s := _require_student();

  select * into v_e from exams where id = p_exam and is_open;
  if not found then
    raise exception '지금 응시할 수 없는 시험입니다.';
  end if;
  if v_e.starts_at is not null and now() < v_e.starts_at then
    raise exception '아직 시작 시간이 아닙니다.';
  end if;
  if v_e.ends_at is not null and now() > v_e.ends_at then
    raise exception '응시 시간이 끝났습니다.';
  end if;

  select count(*) into v_used from submissions
   where exam_id = v_e.id and user_id = v_s.user_id;
  if v_used >= v_e.max_attempts then
    raise exception '응시 가능 횟수를 모두 사용했습니다.';
  end if;

  select coalesce(jsonb_agg(t.item order by t.ord), '[]'::jsonb)
    into v_qs
    from (
      select jsonb_build_object(
               'id', q.id,
               'num', q.num,
               'kind', q.kind,
               'prompt', q.prompt,
               'points', q.points,
               'options', case when q.kind = 'choice' then (
                   select coalesce(jsonb_agg(jsonb_build_object('k', o.k, 't', o.t)
                                    order by case when v_e.shuffle_options then random() else o.k end),
                                   '[]'::jsonb)
                     from (values (1, q.opt1), (2, q.opt2), (3, q.opt3), (4, q.opt4), (5, q.opt5)) as o(k, t)
                    where coalesce(o.t, '') <> '')
                 else '[]'::jsonb end
             ) as item,
             case when v_e.shuffle_questions then random() else q.num end as ord
        from questions q
       where q.exam_id = v_e.id
    ) t;

  return jsonb_build_object(
    'exam', jsonb_build_object(
      'id', v_e.id,
      'title', v_e.title,
      'ends_at', v_e.ends_at,
      'attempt', v_used + 1,
      'max_attempts', v_e.max_attempts),
    'questions', v_qs);
end;
$$;

-- 답안 제출 + 채점 + 기록
-- p_answers: { "문항id": "학생 답" }  (객관식은 보기 번호, 단답형은 글자)
create or replace function public.submit_exam(p_exam uuid, p_answers jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_s      students;
  v_e      exams;
  v_used   int;
  v_score  numeric := 0;
  v_total  numeric := 0;
  v_detail jsonb   := '[]'::jsonb;
  v_given  text;
  v_ok     boolean;
  r        questions;
begin
  v_s := _require_student();

  if p_answers is null or jsonb_typeof(p_answers) <> 'object' or length(p_answers::text) > 50000 then
    raise exception '답안 형식이 올바르지 않습니다.';
  end if;

  -- 같은 학생이 동시에 두 번 제출하는 것을 막는다
  perform pg_advisory_xact_lock(hashtext(v_s.user_id::text || ':' || p_exam::text));

  select * into v_e from exams where id = p_exam and is_open;
  if not found then
    raise exception '지금 제출할 수 없는 시험입니다.';
  end if;
  if v_e.starts_at is not null and now() < v_e.starts_at then
    raise exception '아직 시작 시간이 아닙니다.';
  end if;
  -- 종료 직전 제출이 네트워크 지연으로 늦는 경우를 위해 2분 여유
  if v_e.ends_at is not null and now() > v_e.ends_at + interval '2 minutes' then
    raise exception '제출 시간이 지났습니다.';
  end if;

  select count(*) into v_used from submissions
   where exam_id = v_e.id and user_id = v_s.user_id;
  if v_used >= v_e.max_attempts then
    raise exception '응시 가능 횟수를 모두 사용했습니다.';
  end if;

  for r in select * from questions where exam_id = v_e.id order by num loop
    v_given := coalesce(p_answers ->> r.id::text, '');
    if r.kind = 'choice' then
      v_ok := v_given <> ''
              and v_given = any (string_to_array(regexp_replace(r.answer, '\s+', '', 'g'), '|'));
    else
      v_ok := _norm(v_given) <> ''
              and _norm(v_given) = any (select _norm(x) from unnest(string_to_array(r.answer, '|')) as x);
    end if;
    v_total := v_total + r.points;
    if v_ok then
      v_score := v_score + r.points;
    end if;
    v_detail := v_detail || jsonb_build_object('num', r.num, 'ok', v_ok, 'points', r.points);
  end loop;

  insert into submissions (exam_id, user_id, attempt, score, total, answers, detail)
  values (v_e.id, v_s.user_id, v_used + 1, v_score, v_total, p_answers, v_detail);

  return jsonb_build_object(
    'attempt', v_used + 1,
    'max_attempts', v_e.max_attempts,
    'reveal', v_e.reveal,
    'score',  case when v_e.reveal <> 'none'  then v_score  end,
    'total',  case when v_e.reveal <> 'none'  then v_total  end,
    'detail', case when v_e.reveal = 'detail' then v_detail end);
end;
$$;

-- ---------- 수업자료 ↔ 평가 연결 ----------
-- 자료 파일은 GitHub 저장소 docs/materials/ 에 있고, 여기에는 "어느 자료에 어느 평가를 붙였는지"만 둔다.
-- path 는 docs/materials/ 아래 경로 (예: 1단원/개념확인.html)

create table if not exists public.material_links (
  path    text primary key,
  exam_id uuid not null references public.exams(id) on delete cascade
);

alter table public.material_links enable row level security;
drop policy if exists teacher_all on public.material_links;
create policy teacher_all on public.material_links for all to authenticated using (public.is_teacher()) with check (public.is_teacher());

-- 학생용: 자료별로 붙어 있는 (공개된) 평가와 내 응시 상태
create or replace function public.material_links_for_me()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_s students;
begin
  v_s := _require_student();
  return coalesce((
    select jsonb_object_agg(l.path, jsonb_build_object(
             'id', e.id,
             'title', e.title,
             'max_attempts', e.max_attempts,
             'used', (select count(*) from submissions x
                       where x.exam_id = e.id and x.user_id = v_s.user_id),
             'state', case
                        when e.starts_at is not null and now() < e.starts_at then 'before'
                        when e.ends_at   is not null and now() > e.ends_at   then 'after'
                        else 'open' end))
      from material_links l
      join exams e on e.id = l.exam_id
     where e.is_open), '{}'::jsonb);
end;
$$;

-- ---------- 함수 실행 권한 ----------
-- Supabase 는 새 함수를 기본으로 anon/authenticated 에 열어 두므로 명시적으로 정리한다.

revoke all on function public._norm(text)              from public, anon, authenticated;
revoke all on function public._require_student()       from public, anon, authenticated;
revoke all on function public.is_teacher()             from public, anon;
revoke all on function public.my_status()              from public, anon;
revoke all on function public.register_student(int, int) from public, anon;
revoke all on function public.start_exam(uuid)         from public, anon;
revoke all on function public.submit_exam(uuid, jsonb) from public, anon;
revoke all on function public.material_links_for_me()  from public, anon;

grant execute on function public.is_teacher()               to authenticated;
grant execute on function public.my_status()                to authenticated;
grant execute on function public.register_student(int, int) to authenticated;
grant execute on function public.start_exam(uuid)           to authenticated;
grant execute on function public.submit_exam(uuid, jsonb)   to authenticated;
grant execute on function public.material_links_for_me()    to authenticated;

-- ---------- 교사 등록 (본인 Gmail 로 바꾸세요, 소문자) ----------
insert into public.teachers (email) values ('teacher@gmail.com')
on conflict do nothing;
