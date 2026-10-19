/* Shared model validation for loaded data, edits, imports, and public responses. */
(() => {
    'use strict';
    const recordId = /^[a-zA-Z0-9_-]+$/;
    const reserved = new Set(['__proto__', 'prototype', 'constructor']);
    const empty = () => ({ services: [], team: [], songs: [] });
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

    function daysInMonth(year, month) {
        const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    }

    function validDate(value) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const [year, month, day] = value.split('-').map(Number);
        if (year < 1 || month < 1 || month > 12 || day < 1) return false;
        return day <= daysInMonth(year, month);
    }

    function calendarParts(now) {
        try {
            if (!Number.isFinite(Date.prototype.getTime.call(now))) return null;
            return [Date.prototype.getFullYear.call(now), Date.prototype.getMonth.call(now) + 1, Date.prototype.getDate.call(now)];
        } catch {
            return null;
        }
    }

    const calendarString = ([year, month, day]) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    function localDate(now = new Date()) {
        const parts = calendarParts(now);
        return parts && parts[0] >= 1 && parts[0] <= 9999 ? calendarString(parts) : null;
    }

    function serviceLifecycle(service, now = new Date()) {
        const unavailable = { finished: false, archived: false, archiveDate: null };
        if (!validDate(service?.date)) return unavailable;
        const current = calendarParts(now);
        if (!current) return unavailable;
        const today = current[0] * 10000 + current[1] * 100 + current[2];
        const [year, month, day] = service.date.split('-').map(Number);
        const archiveYear = month === 12 ? year + 1 : year;
        const archiveMonth = month === 12 ? 1 : month + 1;
        // Clamp month-end services rather than letting Date roll into another month.
        const archiveDay = Math.min(day, daysInMonth(archiveYear, archiveMonth));
        const archiveDate = calendarString([archiveYear, archiveMonth, archiveDay]);
        // Numeric calendar comparisons avoid UTC, daylight-saving, and years 1–99 conversions.
        return {
            finished: year * 10000 + month * 100 + day < today,
            archived: archiveYear * 10000 + archiveMonth * 100 + archiveDay <= today,
            archiveDate
        };
    }

    function validTime(value) {
        return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    }

    function duration(value) {
        if (!['number', 'string'].includes(typeof value)) throw new Error('Program duration must be a whole number from 1 to 300.');
        if (typeof value === 'string' && !/^\d+(?:\.0+)?$/.test(value.trim())) throw new Error('Program duration must be a whole number from 1 to 300.');
        const minutes = Number(value);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 300) throw new Error('Program duration must be a whole number from 1 to 300.');
        return minutes;
    }

    function checkKeys(value) {
        const pending = [{ value, depth: 0 }], seen = new WeakSet();
        while (pending.length) {
            const next = pending.pop();
            if (next.value === null || typeof next.value !== 'object') continue;
            if (next.depth > 20 || seen.has(next.value)) throw new Error('Planner data is too deeply nested or contains a circular reference.');
            seen.add(next.value);
            for (const [key, entry] of Object.entries(next.value)) {
                if (reserved.has(key)) throw new Error('Planner data contains an unsafe property name.');
                if (entry !== null && typeof entry === 'object') pending.push({ value: entry, depth: next.depth + 1 });
            }
        }
    }

    function validate(planner) {
        if (!object(planner) || !['services', 'team', 'songs'].every(key => Array.isArray(planner[key]))) throw new Error('Invalid planner data: services, team, and songs must be lists.');
        checkKeys(planner);
        for (const kind of ['services', 'team', 'songs']) {
            const ids = new Set();
            for (const record of planner[kind]) {
                if (!object(record) || typeof record.id !== 'string' || !recordId.test(record.id) || ids.has(record.id)) throw new Error('Invalid or duplicate record ID.');
                ids.add(record.id);
                for (const [key, value] of Object.entries(record)) {
                    if (key === 'is_public') {
                        if (typeof value !== 'boolean') throw new Error('Publication visibility must be a boolean.');
                    } else if (kind === 'services' && key === 'program') {
                        if (!Array.isArray(value)) throw new Error('Service program must be a list.');
                    } else if (typeof value !== 'string') throw new Error('Invalid record field.');
                }
                const name = kind === 'team' ? record.name : record.title;
                if (typeof name !== 'string' || !name.trim()) throw new Error('Please enter a record name.');
                if (kind !== 'services') continue;
                if (!validDate(record.date)) throw new Error('Choose a valid calendar date for the service.');
                if (!validTime(record.time)) throw new Error('Choose a valid service time from 00:00 to 23:59.');
                if (!Array.isArray(record.program)) throw new Error('Service program must be a list.');
                for (const item of record.program) {
                    if (!object(item) || typeof item.title !== 'string' || !item.title.trim() || typeof item.person !== 'string') throw new Error('Invalid program item.');
                    duration(item.minutes);
                    if (Object.hasOwn(item, 'public_assignment') && typeof item.public_assignment !== 'boolean') throw new Error('Assignment visibility must be a boolean.');
                }
            }
        }
        return planner;
    }

    function exactFields(value, required, optional = []) {
        if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
            throw new Error('The public schedule response is invalid. Ask an administrator to check the public-view migration.');
        }
    }

    function validatePublic(planner) {
        exactFields(planner, ['services', 'songs']);
        if (!Array.isArray(planner.services) || !Array.isArray(planner.songs)) throw new Error('Invalid public schedule lists.');
        for (const [kind, records] of [['services', planner.services], ['songs', planner.songs]]) {
            const ids = new Set();
            for (const record of records) {
                exactFields(record, kind === 'services' ? ['id', 'title', 'date', 'time', 'theme', 'location', 'program'] : ['id', 'title']);
                if (typeof record.id !== 'string' || !recordId.test(record.id) || ids.has(record.id) || typeof record.title !== 'string' || !record.title.trim()) throw new Error('Invalid public record.');
                ids.add(record.id);
                if (kind !== 'services') continue;
                if (!validDate(record.date) || !validTime(record.time) || typeof record.theme !== 'string' || typeof record.location !== 'string' || !Array.isArray(record.program)) throw new Error('Invalid public service.');
                for (const item of record.program) {
                    exactFields(item, ['title', 'minutes'], ['person']);
                    if (typeof item.title !== 'string' || !item.title.trim() || typeof item.minutes !== 'number' || Object.hasOwn(item, 'person') && typeof item.person !== 'string') throw new Error('Invalid public program item.');
                    duration(item.minutes);
                }
            }
        }
        return planner;
    }

    const date = value => validDate(value) ? new Date(`${value}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'Date unavailable';
    const message = (error, fallback = 'Something went wrong. Please try again.') => typeof error?.message === 'string' ? error.message : fallback;
    window.GatherPlanner = Object.freeze({ empty, escape, validDate, validTime, localDate, serviceLifecycle, duration, validate, validatePublic, date, message });
})();
