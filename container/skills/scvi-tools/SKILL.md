# scvi-tools — Deep Learning for Single-Cell Analysis

Python library for probabilistic modeling of single-cell omics data. Use for data integration, batch correction, cell type annotation, and more.

## Setup

On first use, create a virtual environment in the project workspace and install:

```bash
cd /workspace/extra/blood_vessel_hypoxia
python3 -m venv .venv
source .venv/bin/activate
pip install scvi-tools scanpy anndata matplotlib
```

Activate on subsequent runs:

```bash
source /workspace/extra/blood_vessel_hypoxia/.venv/bin/activate
```

## Key Models

| Model | Use Case | Input |
|-------|----------|-------|
| **scVI** | Data integration, batch correction, dimensionality reduction | scRNA-seq |
| **scANVI** | Semi-supervised cell type annotation + integration | scRNA-seq + labels |
| **totalVI** | Multi-modal RNA + protein (CITE-seq) | CITE-seq |
| **PeakVI** | Chromatin accessibility | scATAC-seq |
| **MultiVI** | Joint RNA + ATAC | Multiome |
| **DestVI** | Spatial transcriptomics deconvolution | Spatial + scRNA-seq reference |
| **veloVI** | RNA velocity estimation | RNA velocity |

## Common Workflows

### Data Integration with scVI

```python
import scanpy as sc
import scvi

adata = sc.read_h5ad("data.h5ad")
scvi.model.SCVI.setup_anndata(adata, batch_key="batch")
model = scvi.model.SCVI(adata)
model.train()
adata.obsm["X_scVI"] = model.get_latent_representation()
sc.pp.neighbors(adata, use_rep="X_scVI")
sc.tl.umap(adata)
```

### Cell Type Annotation with scANVI

```python
scvi.model.SCANVI.setup_anndata(adata, batch_key="batch", labels_key="cell_type")
model = scvi.model.SCANVI(adata)
model.train()
adata.obs["predicted"] = model.predict()
```

### Differential Expression

```python
model = scvi.model.SCVI.load("model_dir", adata)
de = model.differential_expression(groupby="cell_type", group1="EC", group2="SMC")
```

## Best Practices

- **Filtering**: Apply standard QC before scvi-tools (filter cells/genes, remove doublets).
- **Highly variable genes**: Select 2000–4000 HVGs with `scanpy.pp.highly_variable_genes(batch_key=...)`.
- **Raw counts**: scvi-tools expects raw (unnormalized) counts in `adata.X` or `adata.layers["counts"]`.
- **GPU**: Training is faster with GPU but works on CPU. Set `accelerator="cpu"` if no GPU.
- **Save models**: `model.save("model_dir")` to avoid retraining.
