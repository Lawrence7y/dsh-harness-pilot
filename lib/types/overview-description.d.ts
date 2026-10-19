/** Display-only account redaction; machine selectors and declaration text remain untouched. */
export declare function redactOverviewDescription(description: string, seeds: readonly {
    readonly id: string;
}[]): string;
