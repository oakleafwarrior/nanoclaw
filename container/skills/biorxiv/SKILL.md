# bioRxiv Preprint Search

Search and retrieve preprints from bioRxiv and medRxiv.

## Usage

```bash
# Search by keyword
biorxiv search "hypoxia endothelial single cell"
biorxiv search "VEGF angiogenesis" --limit 20

# Get full details (title, authors, abstract)
biorxiv details "10.1101/2024.01.15.575123"

# Recent preprints in a subject area
biorxiv recent "cell-biology" --days 14

# Check if a preprint has been peer-reviewed and published
biorxiv published "10.1101/2024.01.15.575123"

# List subject categories
biorxiv categories
```

## Tips

- Search queries support multiple keywords; more specific queries yield better results.
- Use `details` after `search` to get the full abstract for promising hits.
- Use `published` to check whether a preprint has been formally peer-reviewed.
- `recent` is useful for monitoring new work in a field.
