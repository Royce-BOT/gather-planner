/* Pure planner views. The controller owns sessions, state, and event binding. */
(() => {
    'use strict';
    const { escape: esc, date, validDate, serviceLifecycle } = GatherPlanner;
    const titles = {
        overview: 'Overview', services: 'Worship schedules', team: 'Ministry team',
        songs: 'Song library', program: 'Service program'
    };
    const heading = (title, subtitle, action = '') => `
        <div class="heading"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${action}</div>`;
    const location = service => service.location || 'Location to be announced';
    const bySchedule = (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time);

    function serviceLists(planner, now) {
        const current = [], past = [];
        for (const service of planner.services) {
            (serviceLifecycle(service, now).archived ? past : current).push(service);
        }
        return { current: current.sort(bySchedule), past: past.sort((a, b) => bySchedule(b, a)) };
    }

    function finishedBanner(service, now, compact = false) {
        if (!serviceLifecycle(service, now).finished) return '';
        return `<div class="program-finished${compact ? ' program-finished-compact' : ''}"><span aria-hidden="true">✓</span><strong>Program finished</strong>${compact ? '' : '<span>This service date has passed.</span>'}</div>`;
    }

    function serviceRow(service, now) {
        const day = validDate(service.date) ? new Date(`${service.date}T12:00:00`) : null;
        return `<div class="row">
            <div class="date">${day ? day.toLocaleDateString('en-US', { month: 'short' }).toUpperCase() : '—'}<b>${day ? day.getDate() : '—'}</b></div>
            <div class="rowinfo"><b>${esc(service.title)}</b><p>${esc(service.time)} · ${esc(location(service))}</p>${finishedBanner(service, now, true)}</div>
            <button class="textbutton" data-open="${esc(service.id)}">View →</button>
        </div>`;
    }

    function overview({ planner, privateAccess, canEdit, now = new Date() }) {
        const calendar = serviceLists(planner, now).current;
        const next = calendar.find(service => new Date(`${service.date}T${service.time}:00`) >= now);
        let html = heading(
            privateAccess ? 'A little planning. A lot of purpose.' : 'Gather for worship.',
            privateAccess ? 'Welcome to your ministry workspace. Let’s prepare for what’s ahead.' : 'Explore worship schedules, service programs, and songs.',
            canEdit ? '<button class="primary" data-add="services">+ Plan a service</button>' : ''
        );
        html += next ? `<section class="hero"><div>
            <span class="eyebrow">COMING TOGETHER NEXT</span><h2>${esc(next.title)}</h2>
            <p>${date(next.date)} · ${esc(next.time)} · ${esc(location(next))}</p>
            <button class="secondary" data-open="${esc(next.id)}">Open service program &nbsp; ↗</button>
        </div></section>` : `<div class="hero">${privateAccess ? 'No upcoming services yet. Your next meaningful gathering starts here.' : 'Check back for the next public worship schedule.'}</div>`;
        html += `<div class="stats ${privateAccess ? '' : 'public-stats'}">
            <div class="stat"><span>${privateAccess ? 'PLANNED' : 'PUBLIC'} SERVICES</span><b>${calendar.length}</b><small>Current plans</small></div>
            ${privateAccess ? `<div class="stat"><span>MINISTRY VOLUNTEERS</span><b>${planner.team.length}</b><small>People making it possible</small></div>` : ''}
            <div class="stat"><span>${privateAccess ? 'SONGS IN YOUR LIBRARY' : 'PUBLISHED SONGS'}</span><b>${planner.songs.length}</b><small>Worship with one voice</small></div>
        </div><div class="columns"><section class="panel">
            <div class="panelhead"><h2>${privateAccess ? 'Your service calendar' : 'Worship schedules'}</h2><button class="textbutton" data-view="services">View all →</button></div>
            ${calendar.slice(0, 4).map(service => serviceRow(service, now)).join('') || `<p>${privateAccess ? 'No current plans. Open Service planner to browse Past programs.' : 'No current public schedules. Browse Past programs in Worship schedules.'}</p>`}
        </section>`;
        html += privateAccess ? `<section class="panel">
            <div class="panelhead"><h2>People behind the ministry</h2><button class="textbutton" data-view="team">View team →</button></div>
            ${planner.team.slice(0, 4).map(person => `<div class="row">
                <span class="avatar">${esc(person.name.split(' ').filter(Boolean).map(word => word[0]).slice(0, 2).join(''))}</span>
                <div class="rowinfo"><b>${esc(person.name)}</b><p>${esc(person.role)} · ${esc(person.ministry)}</p></div>
            </div>`).join('') || '<p>Add your first volunteer.</p>'}
        </section>` : `<section class="panel">
            <div class="panelhead"><h2>Worship with one voice</h2><button class="textbutton" data-view="songs">View songs →</button></div>
            ${planner.songs.slice(0, 4).map(song => `<div class="row"><div class="rowinfo"><b>${esc(song.title)}</b></div></div>`).join('') || '<p>No songs published yet.</p>'}
        </section>`;
        return html + '</div>';
    }

    function program({ privateAccess, canEdit, now, serviceRange }, service) {
        const duration = service.program.reduce((total, item) => total + Number(item.minutes), 0);
        const items = service.program.map((item, index) => {
            const person = privateAccess ? item.person || 'Volunteer needed' : item.person || '';
            return `<div class="programrow"><small>${String(index + 1).padStart(2, '0')}</small>
                <div><b>${esc(item.title)}</b><p>${person ? `${esc(person)} · ` : ''}${Number(item.minutes)} min</p></div>
                ${canEdit ? `<div>
                    <button class="textbutton" data-item="${index}">Edit</button>
                    <button class="textbutton" data-move="${index}" ${index === 0 ? 'disabled' : ''} aria-label="Move program item up">↑</button>
                    <button class="textbutton" data-remove-item="${index}" aria-label="Remove program item">×</button>
                </div>` : ''}
            </div>`;
        }).join('') || '<p>The service program will be added here.</p>';
        return heading(service.title, `${date(service.date)} · ${service.time} · ${location(service)}`, '<button class="primary" data-print>Print program</button>') + finishedBanner(service, now) + `
            <section class="panel"><div class="panelhead">
                <div><span class="eyebrow">SERVICE THEME</span><h2 class="theme-title">${esc(service.theme || 'Worship together')}</h2></div>
                <span class="tag">${duration} minutes</span>
            </div>${items}
            ${canEdit ? `<div class="actions"><button class="secondary" data-add-item>+ Add program item</button><button class="secondary" data-edit="${esc(service.id)}" data-kind="services">Edit service</button></div>` : ''}
            ${privateAccess ? `<p>${esc(service.notes)}</p>` : ''}
            </section><button class="secondary back" data-view="services" data-service-range="${serviceRange}">← ${serviceRange === 'past' ? 'Past programs' : 'Current plans'}</button>`;
    }

    function card(record, kind, { privateAccess, canEdit, now }) {
        const tag = kind === 'services' ? date(record.date) : kind === 'team' ? record.ministry : privateAccess ? 'Key ' + (record.key || '—') : 'Worship song';
        const subtitle = kind === 'services' ? record.theme : kind === 'team' ? record.role : privateAccess && record.number ? 'Hymn #' + record.number : '';
        const detail = kind === 'services' ? record.time + ' · ' + location(record) : kind === 'team' ? record.contact : privateAccess ? record.notes : '';
        const search = Object.values(record).filter(value => typeof value === 'string').join(' ').toLowerCase();
        return `<article class="card" data-search="${esc(search)}">
            ${kind === 'services' ? finishedBanner(record, now) : ''}
            <span class="tag">${esc(tag)}</span><h2>${esc(record.title || record.name)}</h2>
            ${privateAccess && ['services', 'songs'].includes(kind) ? `<span class="tag">${record.is_public === true ? 'Published for visitors' : 'Church members'}</span>` : ''}
            <p>${esc(subtitle)}</p><p>${esc(detail)}</p><div class="actions">
                ${kind === 'services' ? `<button class="primary" data-open="${esc(record.id)}">Open program →</button>` : ''}
                ${canEdit ? `<button class="secondary" data-edit="${esc(record.id)}" data-kind="${kind}">Edit</button><button class="textbutton" data-delete="${esc(record.id)}" data-kind="${kind}">Delete</button>` : ''}
            </div>
        </article>`;
    }

    function cards(model, kind) {
        const { planner, privateAccess, canEdit, now, serviceRange } = model;
        const descriptions = {
            services: [privateAccess ? 'Service planner' : 'Worship schedules', 'Make space for worship, fellowship, and prayer.', 'Plan a service'],
            team: ['Ministry team', 'Keep the people who serve connected and organized.', 'Add volunteer'],
            songs: ['Song library', 'Worship with the songs your congregation loves.', 'Add song']
        };
        const [title, subtitle, action] = descriptions[kind];
        let records = planner[kind], filters = '', emptyMessage = privateAccess ? 'Nothing here yet.' : 'No public entries have been published yet.';
        if (kind === 'services') {
            const lists = serviceLists(planner, now);
            records = lists[serviceRange];
            filters = `<div class="service-filters" role="group" aria-label="Service planner views">
                <button class="service-filter" data-service-range="current" aria-pressed="${serviceRange === 'current'}">Current plans <span>${lists.current.length}</span></button>
                <button class="service-filter" data-service-range="past" aria-pressed="${serviceRange === 'past'}">Past programs <span>${lists.past.length}</span></button>
            </div><p class="service-list-help">${serviceRange === 'past' ? 'Services move here one calendar month after their date. Open any program to revisit it.' : 'Upcoming services and recently finished programs. Older services are kept in Past programs.'}</p>`;
            emptyMessage = serviceRange === 'past'
                ? 'No past programs yet. Services appear here one calendar month after their date.'
                : 'No current plans. Check Past programs for older services.';
        }
        return heading(title, subtitle, canEdit ? `<button class="primary" data-add="${kind}">+ ${action}</button>` : '') + filters + `
            <input class="search" id="search" placeholder="Search ${esc(title.toLowerCase())}…" aria-label="Search">
            <div class="grid">${records.map(record => card(record, kind, model)).join('') || `<div class="empty">${emptyMessage}</div>`}</div>
            <p id="noresults" hidden>No matching entries.</p>`;
    }

    function page(model) {
        model = { ...model, now: model.now || new Date(), serviceRange: model.serviceRange === 'past' ? 'past' : 'current' };
        let view = Object.hasOwn(titles, model.view) ? model.view : 'overview';
        if (!model.privateAccess && view === 'team') view = 'overview';
        const service = model.planner.services.find(record => record.id === model.selected);
        if (view === 'program' && !service) view = 'services';
        const breadcrumb = (model.privateAccess ? 'Workspace / ' : 'Public / ') + titles[view];
        if (!model.privateAccess && !model.publicReady) {
            return { view, breadcrumb, html: `<section class="panel access-panel">
                <span class="eyebrow">WELCOME TO GATHER</span><h1>${model.publicError ? 'Schedules unavailable' : 'Gather for worship.'}</h1>
                <p role="status">${esc(model.publicError || 'Loading public worship schedules…')}</p>
                ${model.publicError ? '<button class="secondary" id="retry-public">Try again</button>' : ''}
            </section>` };
        }
        let html = !model.privateAccess && model.publicError ? `<p class="notice" role="status">${esc(model.publicError)} Showing the last loaded public schedules.</p>` : '';
        if (!model.privateAccess && model.publicLoading) html += '<p class="notice" role="status">Updating public schedules…</p>';
        html += view === 'overview' ? overview(model) : view === 'program' ? program(model, service) : cards(model, view);
        return { view, breadcrumb, html };
    }

    window.GatherView = Object.freeze({ page });
})();
