// 화면(index.html, teacher.html)이 쓰는 API.
// config.js 가 채워져 있으면 Supabase 에 연결하고, 비어 있거나 주소에 ?demo 가 있으면
// 브라우저 안에서만 도는 데모 모드로 동작한다.
(function () {
  const cfg = window.EXAM_CONFIG || {};
  const isDemo = new URLSearchParams(location.search).has('demo') || !cfg.SUPABASE_URL;

  // ---------------- 수업자료 (GitHub Pages 의 materials 폴더) ----------------
  // 목록(materials/index.json)은 배포할 때 tools/build-materials.mjs 가 만든다.
  async function loadMaterials() {
    const res = await fetch('materials/index.json', { cache: 'no-cache' });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error('수업자료 목록을 불러오지 못했습니다.');
    return (await res.json()).items || [];
  }
  const materialUrl = (path) => 'materials/' + path.split('/').map(encodeURIComponent).join('/');

  // 자료를 샌드박스 iframe(srcdoc)으로 보여주기 위해 HTML 을 고친다.
  //  - <base>: 자료 안의 상대 경로(이미지 등)가 원래 폴더 기준으로 열리도록
  //  - storage 대체: 샌드박스에서는 localStorage 접근이 막혀 오류가 나므로 메모리 저장소로 바꿔 끼움
  // 샌드박스(allow-same-origin 없음)라서 자료 코드는 이 사이트의 로그인 정보에 접근할 수 없다.
  async function materialDoc(path) {
    const res = await fetch(materialUrl(path), { cache: 'no-cache' });
    if (!res.ok) throw new Error('자료 파일을 열 수 없습니다.');
    const html = await res.text();
    const base = new URL(materialUrl(path), location.href).href.replace(/[^/]*$/, '');
    const shim = '<base href="' + base + '"><script>(function(){function m(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}["localStorage","sessionStorage"].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:m(),configurable:true})}catch(_){}}})})();<\/script>';
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + shim) : shim + html;
  }

  // ---------------- 실제 모드 (Supabase) ----------------
  function supabaseApi() {
    const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const rpc = async (fn, args) => {
      const { data, error } = await sb.rpc(fn, args);
      if (error) throw new Error(error.message);
      return data;
    };
    const run = async (query) => {
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return data;
    };

    return {
      demo: false,
      async user() {
        const { data } = await sb.auth.getSession();
        return data.session ? { email: data.session.user.email } : null;
      },
      async signIn() {
        const { error } = await sb.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: location.origin + location.pathname,
            queryParams: { prompt: 'select_account' },
          },
        });
        if (error) throw new Error(error.message);
      },
      async signOut() { await sb.auth.signOut(); },

      status: () => rpc('my_status'),
      register: (classNo, studentNo) => rpc('register_student', { p_class: classNo, p_no: studentNo }),
      start: (examId) => rpc('start_exam', { p_exam: examId }),
      submit: (examId, answers) => rpc('submit_exam', { p_exam: examId, p_answers: answers }),
      materials: loadMaterials,
      materialLinks: () => rpc('material_links_for_me'),

      teacher: {
        students: () => run(sb.from('students').select('*').order('class_no').order('student_no')),
        setApproved: (userId, approved) => run(sb.from('students').update({ approved }).eq('user_id', userId)),
        removeStudent: (userId) => run(sb.from('students').delete().eq('user_id', userId)),

        exams: () => run(sb.from('exams').select('*').order('created_at', { ascending: false })),
        saveExam(exam) {
          const { id, created_at, ...fields } = exam;
          return id
            ? run(sb.from('exams').update(fields).eq('id', id).select().single())
            : run(sb.from('exams').insert(fields).select().single());
        },
        deleteExam: (id) => run(sb.from('exams').delete().eq('id', id)),

        questions: (examId) => run(sb.from('questions').select('*').eq('exam_id', examId).order('num')),
        async replaceQuestions(examId, rows) {
          await run(sb.from('questions').delete().eq('exam_id', examId));
          if (rows.length) await run(sb.from('questions').insert(rows.map((r) => ({ ...r, exam_id: examId }))));
        },

        submissions: (examId) => run(sb.from('submissions')
          .select('*, students(class_no, student_no, email)')
          .eq('exam_id', examId)
          .order('submitted_at')),

        links: () => run(sb.from('material_links').select('*')),
        setLink: (path, examId) => examId
          ? run(sb.from('material_links').upsert({ path, exam_id: examId }))
          : run(sb.from('material_links').delete().eq('path', path)),
      },
    };
  }

  // ---------------- 데모 모드 (브라우저 저장소) ----------------
  // DB 함수(schema.sql)와 같은 규칙을 흉내 낸다. 화면 미리보기용.
  function demoApi() {
    const KEY = 'exam-demo-db-v2';
    const ME = { student: 'student@demo', teacher: 'teacher@demo' };
    const role = location.pathname.endsWith('teacher.html') ? 'teacher' : 'student';
    const uid = (email) => 'u-' + email;

    function seed() {
      const ex = 'ex-1';
      return {
        signedIn: false,
        links: { '0-예시/분수-막대.html': ex },
        exams: [{
          id: ex, title: '[데모] 1단원 형성평가', starts_at: null, ends_at: null, max_attempts: 2,
          reveal: 'detail', shuffle_questions: false, shuffle_options: false, is_open: true,
          created_at: new Date().toISOString(),
        }],
        questions: [
          { id: 'q1', exam_id: ex, num: 1, kind: 'choice', prompt: '다음 중 소수(prime number)는?', opt1: '4', opt2: '6', opt3: '7', opt4: '9', opt5: null, answer: '3', points: 2 },
          { id: 'q2', exam_id: ex, num: 2, kind: 'choice', prompt: '짝수를 모두 고르면? (하나만 골라도 정답)', opt1: '1', opt2: '2', opt3: '3', opt4: '4', opt5: null, answer: '2|4', points: 2 },
          { id: 'q3', exam_id: ex, num: 3, kind: 'short', prompt: '대한민국의 수도는?', opt1: null, opt2: null, opt3: null, opt4: null, opt5: null, answer: '서울|서울특별시', points: 3 },
          { id: 'q4', exam_id: ex, num: 4, kind: 'short', prompt: '물의 화학식을 쓰시오.', opt1: null, opt2: null, opt3: null, opt4: null, opt5: null, answer: 'H2O', points: 3 },
        ],
        students: [
          { user_id: uid('kim@demo'), email: 'kim@demo', class_no: 2, student_no: 3, approved: true, created_at: new Date(Date.now() - 86400e3).toISOString() },
          { user_id: uid('lee@demo'), email: 'lee@demo', class_no: 2, student_no: 11, approved: false, created_at: new Date().toISOString() },
        ],
        submissions: [{
          id: 1, exam_id: ex, user_id: uid('kim@demo'), attempt: 1, score: 7, total: 10,
          answers: { q1: '3', q2: '2', q3: '서울', q4: 'HO2' },
          detail: [{ num: 1, ok: true, points: 2 }, { num: 2, ok: true, points: 2 }, { num: 3, ok: true, points: 3 }, { num: 4, ok: false, points: 3 }],
          submitted_at: new Date(Date.now() - 3600e3).toISOString(),
        }],
      };
    }
    let mem = null;
    function load() {
      if (mem) return mem;
      try { mem = JSON.parse(localStorage.getItem(KEY)); } catch (e) { mem = null; }
      if (!mem) mem = seed();
      return mem;
    }
    function save() { try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch (e) { /* 저장 불가해도 메모리로 동작 */ } }
    const wait = (v) => new Promise((res) => setTimeout(() => res(structuredClone(v)), 150));
    const fail = (msg) => Promise.reject(new Error(msg));
    const norm = (t) => String(t ?? '').replace(/\s+/g, '').toLowerCase();
    const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

    function myEmail() { return load().signedIn ? ME[role] : null; }
    function myStudent() { return load().students.find((s) => s.email === myEmail()); }
    function examState(e) {
      const now = Date.now();
      if (e.starts_at && now < Date.parse(e.starts_at)) return 'before';
      if (e.ends_at && now > Date.parse(e.ends_at)) return 'after';
      return 'open';
    }
    function used(examId, userId) { return load().submissions.filter((x) => x.exam_id === examId && x.user_id === userId).length; }
    function requireStudent() {
      const s = myStudent();
      if (!myEmail()) throw new Error('로그인이 필요합니다.');
      if (!s) throw new Error('먼저 반과 번호를 등록해 주세요.');
      if (!s.approved) throw new Error('선생님의 승인을 기다리는 중입니다.');
      return s;
    }
    function status() {
      const email = myEmail();
      if (!email) return fail('로그인이 필요합니다.');
      const s = myStudent();
      const isTeacher = role === 'teacher';
      if (!s) return wait({ email, registered: false, is_teacher: isTeacher });
      const exams = s.approved ? load().exams.filter((e) => e.is_open).map((e) => ({
        id: e.id, title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, max_attempts: e.max_attempts,
        used: used(e.id, s.user_id), state: examState(e),
      })) : [];
      return wait({ email, registered: true, approved: s.approved, class_no: s.class_no, student_no: s.student_no, exams, is_teacher: isTeacher });
    }
    const T = () => {
      if (myEmail() !== ME.teacher) throw new Error('교사 계정이 아닙니다.');
      return load();
    };

    return {
      demo: true,
      async user() { const e = myEmail(); return e ? { email: e } : null; },
      async signIn() { load().signedIn = true; save(); location.reload(); },
      async signOut() { load().signedIn = false; save(); },
      resetDemo() { try { localStorage.removeItem(KEY); } catch (e) { /* 무시 */ } mem = null; },
      approveMe() { const s = myStudent(); if (s) { s.approved = true; save(); } },

      status,
      async register(classNo, studentNo) {
        const db = load();
        if (!(classNo >= 1 && classNo <= 30 && studentNo >= 1 && studentNo <= 60)) return fail('반과 번호를 다시 확인해 주세요.');
        if (myStudent()) return fail('이미 등록한 계정입니다.');
        if (db.students.some((s) => s.class_no === classNo && s.student_no === studentNo)) {
          return fail(`${classNo}반 ${studentNo}번은 이미 다른 계정으로 등록되어 있습니다. 선생님께 알려 주세요.`);
        }
        db.students.push({ user_id: uid(myEmail()), email: myEmail(), class_no: classNo, student_no: studentNo, approved: false, created_at: new Date().toISOString() });
        save();
        return status();
      },
      async start(examId) {
        const s = requireStudent();
        const e = load().exams.find((x) => x.id === examId && x.is_open);
        if (!e) throw new Error('지금 응시할 수 없는 시험입니다.');
        const st = examState(e);
        if (st === 'before') throw new Error('아직 시작 시간이 아닙니다.');
        if (st === 'after') throw new Error('응시 시간이 끝났습니다.');
        const n = used(e.id, s.user_id);
        if (n >= e.max_attempts) throw new Error('응시 가능 횟수를 모두 사용했습니다.');
        let qs = load().questions.filter((q) => q.exam_id === e.id).sort((a, b) => a.num - b.num).map((q) => {
          let options = q.kind === 'choice'
            ? [q.opt1, q.opt2, q.opt3, q.opt4, q.opt5].map((t, i) => ({ k: i + 1, t })).filter((o) => o.t)
            : [];
          if (e.shuffle_options) options = shuffle(options);
          return { id: q.id, num: q.num, kind: q.kind, prompt: q.prompt, points: q.points, options };
        });
        if (e.shuffle_questions) qs = shuffle(qs);
        return wait({ exam: { id: e.id, title: e.title, ends_at: e.ends_at, attempt: n + 1, max_attempts: e.max_attempts }, questions: qs });
      },
      materials: loadMaterials,
      async materialLinks() {
        const s = requireStudent();
        const out = {};
        for (const [path, examId] of Object.entries(load().links || {})) {
          const e = load().exams.find((x) => x.id === examId && x.is_open);
          if (e) out[path] = { id: e.id, title: e.title, max_attempts: e.max_attempts, used: used(e.id, s.user_id), state: examState(e) };
        }
        return wait(out);
      },
      async submit(examId, answers) {
        const s = requireStudent();
        const db = load();
        const e = db.exams.find((x) => x.id === examId && x.is_open);
        if (!e) throw new Error('지금 제출할 수 없는 시험입니다.');
        if (e.ends_at && Date.now() > Date.parse(e.ends_at) + 120e3) throw new Error('제출 시간이 지났습니다.');
        const n = used(e.id, s.user_id);
        if (n >= e.max_attempts) throw new Error('응시 가능 횟수를 모두 사용했습니다.');
        let score = 0, total = 0;
        const detail = db.questions.filter((q) => q.exam_id === e.id).sort((a, b) => a.num - b.num).map((q) => {
          const given = String(answers[q.id] ?? '');
          const ok = q.kind === 'choice'
            ? given !== '' && q.answer.replace(/\s+/g, '').split('|').includes(given)
            : norm(given) !== '' && q.answer.split('|').some((a) => norm(a) === norm(given));
          total += Number(q.points);
          if (ok) score += Number(q.points);
          return { num: q.num, ok, points: q.points };
        });
        db.submissions.push({ id: Date.now(), exam_id: e.id, user_id: s.user_id, attempt: n + 1, score, total, answers, detail, submitted_at: new Date().toISOString() });
        save();
        return wait({
          attempt: n + 1, max_attempts: e.max_attempts, reveal: e.reveal,
          score: e.reveal !== 'none' ? score : null,
          total: e.reveal !== 'none' ? total : null,
          detail: e.reveal === 'detail' ? detail : null,
        });
      },

      teacher: {
        async students() { return wait(T().students.slice().sort((a, b) => a.class_no - b.class_no || a.student_no - b.student_no)); },
        async setApproved(userId, approved) { const s = T().students.find((x) => x.user_id === userId); if (s) s.approved = approved; save(); return wait(null); },
        async removeStudent(userId) { const db = T(); db.students = db.students.filter((x) => x.user_id !== userId); db.submissions = db.submissions.filter((x) => x.user_id !== userId); save(); return wait(null); },
        async exams() { return wait(T().exams.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))); },
        async saveExam(exam) {
          const db = T();
          if (exam.id) { Object.assign(db.exams.find((x) => x.id === exam.id), exam); save(); return wait(db.exams.find((x) => x.id === exam.id)); }
          const row = { ...exam, id: 'ex-' + Date.now(), created_at: new Date().toISOString() };
          db.exams.push(row); save(); return wait(row);
        },
        async deleteExam(id) { const db = T(); db.exams = db.exams.filter((x) => x.id !== id); db.questions = db.questions.filter((x) => x.exam_id !== id); db.submissions = db.submissions.filter((x) => x.exam_id !== id); save(); return wait(null); },
        async questions(examId) { return wait(T().questions.filter((q) => q.exam_id === examId).sort((a, b) => a.num - b.num)); },
        async replaceQuestions(examId, rows) {
          const db = T();
          db.questions = db.questions.filter((q) => q.exam_id !== examId)
            .concat(rows.map((r, i) => ({ ...r, id: 'q-' + Date.now() + '-' + i, exam_id: examId })));
          save(); return wait(null);
        },
        async links() { return wait(Object.entries(T().links || {}).map(([path, exam_id]) => ({ path, exam_id }))); },
        async setLink(path, examId) {
          const db = T();
          db.links = db.links || {};
          if (examId) db.links[path] = examId; else delete db.links[path];
          save(); return wait(null);
        },
        async submissions(examId) {
          const db = T();
          return wait(db.submissions.filter((x) => x.exam_id === examId).map((x) => {
            const s = db.students.find((st) => st.user_id === x.user_id) || {};
            return { ...x, students: { class_no: s.class_no, student_no: s.student_no, email: s.email } };
          }));
        },
      },
    };
  }

  window.ExamApi = isDemo ? demoApi() : supabaseApi();
  window.ExamApi.materialUrl = materialUrl;
  window.ExamApi.materialDoc = materialDoc;
  window.ExamApi.githubRepo = cfg.GITHUB_REPO || '';

  // ---------------- 화면 공통 도우미 ----------------
  // h('div', { class: 'x', onclick: fn }, '글자', 자식요소...)
  window.h = function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  };

  window.fmtDate = function (iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
})();
