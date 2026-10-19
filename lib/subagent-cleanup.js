/** Listing failures are unknown, not evidence of removal. Never delete those routes. */
export function obsoleteSubagentRoutes(allowed, catalog) {
    const failed = new Set((catalog.failures ?? []).map(row => row.id));
    const available = new Set(catalog.groups.flatMap(group => group.models.map(model => `${group.id}\0${model.id}`)));
    return allowed.filter(row => !failed.has(row.provider) && !available.has(`${row.provider}\0${row.model}`));
}
//# sourceMappingURL=subagent-cleanup.js.map