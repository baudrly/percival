class GenomeReassemblyTool {
    constructor() {
        this.fastaData = null;
        this.contactMap = null;
        this.chromosomes = [];
        this.binSize = 1000000;
        this.currentState = null;
        this.history = [];
        this.historyIndex = -1;
        this.selectedTool = 'select';
        this.selection = null;
        this.secondSelection = null;
        this.pendingOperation = null;
        this.operationStep = 0;
        
        this.vizSettings = {
            transform: 'log',
            colorScheme: 'turbo',
            vmin: 0,
            vmax: 100,
            gamma: 1.0,
            percentileClip: false,
            showGrid: true,
            showDiagonal: false,
            minChromosomeSize: 10
        };
        
        this.colorSchemes = {
            viridis: [[68, 1, 84], [72, 40, 120], [62, 73, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]],
            plasma: [[13, 8, 135], [84, 2, 163], [139, 10, 165], [185, 50, 137], [219, 92, 104], [244, 136, 73], [254, 188, 43], [240, 249, 33]],
            inferno: [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]],
            turbo: [[48, 18, 59], [68, 124, 202], [41, 188, 219], [65, 225, 92], [184, 225, 30], [251, 191, 39], [245, 99, 32], [189, 36, 40], [122, 4, 3]],
            hot: [[10, 0, 0], [178, 0, 0], [255, 51, 0], [255, 178, 0], [255, 255, 51], [255, 255, 178], [255, 255, 255]],
            cool: [[0, 255, 255], [255, 0, 255]]
        };
        
        this.initializeEventListeners();
    }
    
    initializeEventListeners() {
        // Tab navigation
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                e.target.classList.add('active');
                document.getElementById(`${e.target.dataset.tab}-tab`).classList.add('active');
            });
        });
        
        // Input tabs
        document.querySelectorAll('.input-tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const input = e.target.dataset.input;
                const panel = e.target.closest('.data-panel');
                
                panel.querySelectorAll('.input-tab-btn').forEach(b => b.classList.remove('active'));
                panel.querySelectorAll('.input-content').forEach(c => c.classList.remove('active'));
                
                e.target.classList.add('active');
                panel.querySelector(`#${input}`).classList.add('active');
            });
        });
        
        // Sidebar tabs
        document.querySelectorAll('.sidebar-tab').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.sidebar-tab').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.sidebar-panel').forEach(p => p.style.display = 'none');
                
                e.target.classList.add('active');
                document.getElementById(`${e.target.dataset.sidebar}-panel`).style.display = 'block';
            });
        });
        
        // File inputs
        document.getElementById('fasta-file').addEventListener('change', (e) => this.handleFileUpload(e, 'fasta'));
        document.getElementById('bed-file').addEventListener('change', (e) => this.handleFileUpload(e, 'bed'));
        
        // Demo buttons
        document.querySelectorAll('.demo-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                if (e.target.closest('#fasta-demo')) {
                    this.loadDemoFasta();
                } else {
                    this.loadDemoBed();
                }
            });
        });
        
        // Process button
        document.getElementById('process-btn').addEventListener('click', () => this.processData());
        
        // Tool buttons
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
                e.currentTarget.classList.add('active');
                this.selectedTool = e.currentTarget.dataset.tool;
                this.resetOperation();
            });
        });
        
        // Canvas events
        const canvas = document.getElementById('heatmap-canvas');
        canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        canvas.addEventListener('mouseup', (e) => this.handleMouseUp(e));
        canvas.addEventListener('mouseleave', () => this.hideHoverInfo());
        
        // Operation controls
        document.getElementById('confirm-op').addEventListener('click', () => this.confirmOperation());
        document.getElementById('cancel-op').addEventListener('click', () => this.cancelOperation());
        document.getElementById('reset-op').addEventListener('click', () => this.resetOperation());
        
        // Settings
        this.initializeSettings();
        
        // Export buttons
        document.getElementById('export-bed').addEventListener('click', () => this.exportBed());
        document.getElementById('export-modifications').addEventListener('click', () => this.exportModifications());
        document.getElementById('export-fasta').addEventListener('click', () => this.exportFasta());
        document.getElementById('export-matrix').addEventListener('click', () => this.exportMatrix());
    }
    
    initializeSettings() {
        document.getElementById('transform-select').addEventListener('change', (e) => {
            this.vizSettings.transform = e.target.value;
        });
        
        document.getElementById('colorscheme-select').addEventListener('change', (e) => {
            this.vizSettings.colorScheme = e.target.value;
        });
        
        document.getElementById('vmin-slider').addEventListener('input', (e) => {
            this.vizSettings.vmin = parseFloat(e.target.value);
            document.getElementById('vmin-label').textContent = e.target.value;
        });
        
        document.getElementById('vmax-slider').addEventListener('input', (e) => {
            this.vizSettings.vmax = parseFloat(e.target.value);
            document.getElementById('vmax-label').textContent = e.target.value;
        });
        
        document.getElementById('gamma-slider').addEventListener('input', (e) => {
            this.vizSettings.gamma = parseFloat(e.target.value);
            document.getElementById('gamma-label').textContent = e.target.value;
        });
        
        document.getElementById('min-chr-size').addEventListener('input', (e) => {
            this.vizSettings.minChromosomeSize = parseInt(e.target.value);
            document.getElementById('min-chr-label').textContent = e.target.value;
        });
        
        document.getElementById('percentile-clip').addEventListener('change', (e) => {
            this.vizSettings.percentileClip = e.target.checked;
        });
        
        document.getElementById('grid-toggle').addEventListener('change', (e) => {
            this.vizSettings.showGrid = e.target.checked;
        });
        
        document.getElementById('diagonal-toggle').addEventListener('change', (e) => {
            this.vizSettings.showDiagonal = e.target.checked;
        });
        
        document.getElementById('apply-settings').addEventListener('click', () => {
            if (this.currentState) this.render();
        });
    }
    
    async handleFileUpload(e, type) {
        const file = e.target.files[0];
        if (!file) return;
        
        this.showLoading();
        
        try {
            const content = await this.readFile(file);
            
            if (type === 'fasta') {
                this.fastaData = this.parseFasta(content);
                this.updateStatus('fasta', true, `${Object.keys(this.fastaData).length} sequences`);
            } else {
                this.contactMap = await this.parseContactMap(content);
                this.updateStatus('bed', true, `${this.contactMap.matrix.length}×${this.contactMap.matrix.length} matrix`);
            }
        } catch (error) {
            alert('Error reading file: ' + error.message);
        } finally {
            this.hideLoading();
        }
    }
    
    readFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsText(file);
        });
    }
    
    updateStatus(type, loaded, info) {
        const status = document.getElementById(`${type}-status`);
        if (loaded) {
            status.classList.add('loaded');
            status.querySelector('.status-icon').textContent = '✅';
            status.innerHTML = `<span class="status-icon">✅</span><span>${type.toUpperCase()}: ${info}</span>`;
        }
    }
    
    parseFasta(content) {
        const sequences = {};
        let currentHeader = null;
        let currentSequence = [];
        
        content.split('\n').forEach(line => {
            line = line.trim();
            if (line.startsWith('>')) {
                if (currentHeader) {
                    sequences[currentHeader] = currentSequence.join('');
                }
                currentHeader = line.substring(1).split(/\s+/)[0];
                currentSequence = [];
            } else if (line) {
                currentSequence.push(line);
            }
        });
        
        if (currentHeader) {
            sequences[currentHeader] = currentSequence.join('');
        }
        
        return sequences;
    }
    
    async parseContactMap(content) {
        const lines = content.trim().split('\n').filter(line => line.trim() && !line.startsWith('#'));
        
        // Detect if it's a matrix format
        if (this.isSquareMatrix(lines)) {
            return this.parseMatrixFormat(lines);
        } else {
            return this.parseBedFormat(lines);
        }
    }
    
    isSquareMatrix(lines) {
        if (lines.length < 10) return false;
        const firstRowCols = lines[0].split(/\s+/).length;
        return lines.length === firstRowCols && !isNaN(parseFloat(lines[0].split(/\s+/)[0]));
    }
    
    parseMatrixFormat(lines) {
        const size = lines.length;
        const matrix = lines.map(line => 
            line.split(/\s+/).map(v => parseFloat(v) || 0)
        );
        
        // Generate synthetic chromosome assignments
        const binSize = Math.ceil(size / 3);
        const chromosomes = ['chr1', 'chr2', 'chr3'];
        const binMap = new Map();
        
        let binId = 0;
        chromosomes.forEach((chr, i) => {
            const start = i * binSize;
            const end = Math.min((i + 1) * binSize, size);
            
            for (let j = start; j < end; j++) {
                binMap.set(`${chr}:${j * this.binSize}-${(j + 1) * this.binSize}`, binId++);
            }
        });
        
        this.chromosomes = chromosomes;
        
        return { matrix, binMap, chromosomes };
    }
    
    parseBedFormat(lines) {
        const data = [];
        
        lines.forEach(line => {
            const parts = line.split(/\s+/);
            if (parts.length >= 6) {
                data.push({
                    chr1: parts[0],
                    start1: parseInt(parts[1]),
                    end1: parseInt(parts[2]),
                    chr2: parts[3],
                    start2: parseInt(parts[4]),
                    end2: parseInt(parts[5]),
                    score: parseFloat(parts[6]) || 1
                });
            }
        });
        
        return this.processContactMapData(data);
    }
    
    processContactMapData(data) {
        const chrSet = new Set();
        data.forEach(d => {
            chrSet.add(d.chr1);
            chrSet.add(d.chr2);
        });
        
        this.chromosomes = Array.from(chrSet).sort((a, b) => {
            const aNum = parseInt(a.replace(/\D/g, '')) || 999;
            const bNum = parseInt(b.replace(/\D/g, '')) || 999;
            return aNum - bNum;
        });
        
        const binMap = new Map();
        let binId = 0;
        
        this.chromosomes.forEach(chr => {
            const chrData = data.filter(d => d.chr1 === chr || d.chr2 === chr);
            const positions = new Set();
            
            chrData.forEach(d => {
                if (d.chr1 === chr) {
                    positions.add(d.start1);
                    positions.add(d.end1);
                }
                if (d.chr2 === chr) {
                    positions.add(d.start2);
                    positions.add(d.end2);
                }
            });
            
            const sortedPos = Array.from(positions).sort((a, b) => a - b);
            
            for (let i = 0; i < sortedPos.length - 1; i++) {
                binMap.set(`${chr}:${sortedPos[i]}-${sortedPos[i + 1]}`, binId++);
            }
        });
        
        const matrixSize = binId;
        const matrix = Array(matrixSize).fill(null).map(() => Array(matrixSize).fill(0));
        
        data.forEach(d => {
            const bin1 = binMap.get(`${d.chr1}:${d.start1}-${d.end1}`);
            const bin2 = binMap.get(`${d.chr2}:${d.start2}-${d.end2}`);
            
            if (bin1 !== undefined && bin2 !== undefined) {
                matrix[bin1][bin2] = d.score;
                matrix[bin2][bin1] = d.score;
            }
        });
        
        return { matrix, binMap, chromosomes: this.chromosomes, originalData: data };
    }
    
    loadDemoFasta() {
        this.showLoading();
        
        const demoFasta = `>chr1
ATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCG
ATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCG
>chr2
GCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTA
GCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTA
>chr3
TACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACG
TACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACG`;
        
        this.fastaData = this.parseFasta(demoFasta);
        this.updateStatus('fasta', true, '3 sequences');
        
        setTimeout(() => this.hideLoading(), 500);
    }
    
    loadDemoBed() {
        this.showLoading();
        
        const size = 100;
        const matrix = Array(size).fill(null).map(() => Array(size).fill(0));
        
        for (let i = 0; i < size; i++) {
            for (let j = 0; j < size; j++) {
                const distance = Math.abs(i - j);
                const value = distance === 0 ? 100 : 100 * Math.pow(distance + 1, -1.5) + Math.random() * 5;
                matrix[i][j] = value;
                matrix[j][i] = value;
            }
        }
        
        const chrBlocks = [
            {start: 0, end: 30, chr: 'chr1'},
            {start: 30, end: 65, chr: 'chr2'},
            {start: 65, end: 100, chr: 'chr3'}
        ];
        
        chrBlocks.forEach(block => {
            for (let i = block.start; i < block.end; i++) {
                for (let j = block.start; j < block.end; j++) {
                    matrix[i][j] *= 2;
                }
            }
        });
        
        const binMap = new Map();
        let binId = 0;
        chrBlocks.forEach(block => {
            for (let i = block.start; i < block.end; i++) {
                binMap.set(`${block.chr}:${i * this.binSize}-${(i + 1) * this.binSize}`, binId++);
            }
        });
        
        this.chromosomes = ['chr1', 'chr2', 'chr3'];
        this.contactMap = { matrix, binMap, chromosomes: this.chromosomes };
        
        this.updateStatus('bed', true, '100×100 matrix');
        
        setTimeout(() => this.hideLoading(), 500);
    }
    
    async processData() {
        if (!this.contactMap) {
            alert('Please load a contact map first');
            return;
        }
        
        this.showLoading();
        
        try {
            // Deep copy the matrix
            const matrixCopy = this.contactMap.matrix.map(row => [...row]);
            
            this.currentState = {
                matrix: matrixCopy,
                binOrder: Array.from({length: this.contactMap.matrix.length}, (_, i) => i),
                score: 0,
                psData: null
            };
            
            this.calculatePsDistribution();
            this.calculateScore();
            
            this.saveToHistory('Initial state');
            
            document.querySelector('[data-tab="viz"]').click();
            
            this.render();
        } catch (error) {
            alert('Error processing data: ' + error.message);
        } finally {
            this.hideLoading();
        }
    }
    
    calculatePsDistribution() {
        const matrix = this.currentState.matrix;
        const order = this.currentState.binOrder;
        const size = matrix.length;
        
        const distanceCounts = new Map();
        
        for (let i = 0; i < size; i++) {
            for (let j = i; j < size; j++) {
                const distance = Math.abs(i - j);
                const contact = matrix[order[i]][order[j]];
                
                if (!distanceCounts.has(distance)) {
                    distanceCounts.set(distance, { sum: 0, count: 0 });
                }
                
                distanceCounts.get(distance).sum += contact;
                distanceCounts.get(distance).count += 1;
            }
        }
        
        const psData = [];
        distanceCounts.forEach((value, distance) => {
            if (distance > 0) {
                psData.push({
                    s: distance,
                    p: value.sum / value.count
                });
            }
        });
        
        psData.sort((a, b) => a.s - b.s);
        
        // Robust power law fitting - exclude outliers
        const logData = psData
            .filter(d => d.p > 0 && d.s > 1 && d.s < size * 0.8) // Exclude very close and very far bins
            .map(d => ({
                x: Math.log(d.s),
                y: Math.log(d.p)
            }));
        
        if (logData.length > 2) {
            // Use RANSAC-like approach for robust fitting
            let bestAlpha = -1;
            let bestInliers = 0;
            
            for (let iter = 0; iter < 100; iter++) {
                // Sample two random points
                const idx1 = Math.floor(Math.random() * logData.length);
                const idx2 = Math.floor(Math.random() * logData.length);
                if (idx1 === idx2) continue;
                
                // Calculate slope
                const alpha = -(logData[idx2].y - logData[idx1].y) / (logData[idx2].x - logData[idx1].x);
                
                // Count inliers
                const intercept = logData[idx1].y + alpha * logData[idx1].x;
                let inliers = 0;
                
                logData.forEach(d => {
                    const predicted = intercept - alpha * d.x;
                    const error = Math.abs(predicted - d.y);
                    if (error < 0.5) inliers++;
                });
                
                if (inliers > bestInliers) {
                    bestInliers = inliers;
                    bestAlpha = alpha;
                }
            }
            
            this.currentState.psData = {
                data: psData,
                alpha: bestAlpha
            };
        }
    }
    
    calculateScore() {
        if (!this.currentState.psData) {
            this.currentState.score = 0;
            return;
        }
        
        // Score based on power law fit quality and alpha value
        const idealAlpha = 1.0;
        const alpha = this.currentState.psData.alpha;
        const alphaDiff = Math.abs(alpha - idealAlpha);
        const alphaScore = 100 / (1 + alphaDiff * alphaDiff);
        
        // Calculate R² for power law fit
        const psData = this.currentState.psData.data;
        const logData = psData
            .filter(d => d.p > 0 && d.s > 1 && d.s < psData.length * 0.8)
            .map(d => ({
                x: Math.log(d.s),
                y: Math.log(d.p),
                predicted: Math.log(100) - alpha * Math.log(d.s)
            }));
        
        const meanY = logData.reduce((sum, d) => sum + d.y, 0) / logData.length;
        const ssTotal = logData.reduce((sum, d) => sum + Math.pow(d.y - meanY, 2), 0);
        const ssResidual = logData.reduce((sum, d) => sum + Math.pow(d.y - d.predicted, 2), 0);
        const r2 = 1 - (ssResidual / ssTotal);
        const fitScore = Math.max(0, r2) * 100;
        
        // Diagonal enrichment score
        const matrix = this.currentState.matrix;
        const order = this.currentState.binOrder;
        let diagonalSum = 0;
        let totalSum = 0;
        
        for (let i = 0; i < matrix.length; i++) {
            for (let j = 0; j < matrix.length; j++) {
                const value = matrix[order[i]][order[j]];
                totalSum += value;
                if (Math.abs(i - j) <= 5) {
                    diagonalSum += value;
                }
            }
        }
        
        const diagonalScore = (diagonalSum / totalSum) * 100;
        
        // Combined score with weights
        this.currentState.score = 0.4 * alphaScore + 0.4 * fitScore + 0.2 * diagonalScore;
        
        this.updateScoreDisplay();
    }
    
    updateScoreDisplay() {
        document.getElementById('current-score').textContent = this.currentState.score.toFixed(2);
        document.getElementById('alpha-value').textContent = this.currentState.psData?.alpha.toFixed(2) || '-1.00';
        document.getElementById('ps-alpha').textContent = this.currentState.psData?.alpha.toFixed(2) || '-1.0';
        
        // Update best score
        const bestScore = Math.max(...this.history.map(h => h.state.score || 0), this.currentState.score);
        document.getElementById('best-score').textContent = bestScore.toFixed(2);
    }
    
    saveToHistory(description) {
        // Trim future history if we're not at the end
        if (this.historyIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.historyIndex + 1);
        }
        
        // Deep copy the bin order
        const compressedState = {
            binOrder: [...this.currentState.binOrder],
            score: this.currentState.score,
            psAlpha: this.currentState.psData?.alpha
        };
        
        this.history.push({
            description,
            timestamp: new Date().toISOString(),
            state: compressedState
        });
        
        this.historyIndex = this.history.length - 1;
        
        // Keep only last 50 states
        if (this.history.length > 50) {
            this.history = this.history.slice(-50);
            this.historyIndex = this.history.length - 1;
        }
        
        this.updateHistoryPanel();
    }
    
    updateHistoryPanel() {
        const historyList = document.getElementById('history-list');
        historyList.innerHTML = '';
        
        this.history.slice().reverse().forEach((item, idx) => {
            const actualIdx = this.history.length - 1 - idx;
            const div = document.createElement('div');
            div.className = 'history-item';
            if (actualIdx === this.historyIndex) {
                div.style.background = 'var(--primary)';
            }
            
            div.innerHTML = `
                <div>
                    <div style="font-weight: 600;">${item.description}</div>
                    <div style="font-size: 0.8rem; color: var(--text-tertiary);">
                        ${new Date(item.timestamp).toLocaleTimeString()}
                    </div>
                </div>
                <div class="history-score">${item.state.score.toFixed(2)}</div>
            `;
            
            div.addEventListener('click', () => this.loadFromHistory(actualIdx));
            historyList.appendChild(div);
        });
    }
    
    loadFromHistory(index) {
        if (index < 0 || index >= this.history.length) return;
        
        const item = this.history[index];
        // Deep copy the bin order to prevent mutations
        this.currentState.binOrder = [...item.state.binOrder];
        
        // Recalculate everything from scratch
        this.calculatePsDistribution();
        this.calculateScore();
        
        this.historyIndex = index;
        this.updateHistoryPanel();
        this.render();
    }
    
    render() {
        if (!this.currentState) return;
        
        this.renderHeatmap();
        this.renderPsPlot();
        this.updateScoreDisplay();
    }
    
    transformValue(value) {
        if (value <= 0) return 0;
        
        let transformed;
        switch (this.vizSettings.transform) {
            case 'linear': transformed = value; break;
            case 'log': transformed = Math.log(value + 1); break;
            case 'log2': transformed = Math.log2(value + 1); break;
            case 'sqrt': transformed = Math.sqrt(value); break;
            default: transformed = value;
        }
        
        // Apply gamma correction
        return Math.pow(transformed, 1 / this.vizSettings.gamma);
    }
    
    getColor(value, minVal, maxVal) {
        const transformed = this.transformValue(value);
        const minTransformed = this.transformValue(minVal);
        const maxTransformed = this.transformValue(maxVal);
        
        let normalized = (transformed - minTransformed) / (maxTransformed - minTransformed);
        normalized = Math.max(0, Math.min(1, normalized));
        
        const scheme = this.colorSchemes[this.vizSettings.colorScheme];
        const index = normalized * (scheme.length - 1);
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const fraction = index - lower;
        
        const r = Math.round(scheme[lower][0] * (1 - fraction) + scheme[upper][0] * fraction);
        const g = Math.round(scheme[lower][1] * (1 - fraction) + scheme[upper][1] * fraction);
        const b = Math.round(scheme[lower][2] * (1 - fraction) + scheme[upper][2] * fraction);
        
        return `rgb(${r}, ${g}, ${b})`;
    }
    
    getFilteredChromosomes() {
        const chrSizes = {};
        this.chromosomes.forEach(chr => {
            chrSizes[chr] = this.getChromosomeBins(chr).length;
        });
        
        return this.chromosomes.filter(chr => chrSizes[chr] >= this.vizSettings.minChromosomeSize);
    }
    
    renderHeatmap() {
        const canvas = document.getElementById('heatmap-canvas');
        const ctx = canvas.getContext('2d');
        const matrix = this.currentState.matrix;
        const order = this.currentState.binOrder;
        
        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;
        
        const size = matrix.length;
        const cellSize = canvas.width / size;
        
        // Clear canvas
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Calculate value range
        let minValue = this.vizSettings.vmin;
        let maxValue = this.vizSettings.vmax;
        
        if (this.vizSettings.percentileClip) {
            const values = [];
            for (let i = 0; i < size; i++) {
                for (let j = 0; j < size; j++) {
                    const val = matrix[order[i]][order[j]];
                    if (val > 0) values.push(val);
                }
            }
            values.sort((a, b) => a - b);
            minValue = values[Math.floor(values.length * 0.05)] || 0;
            maxValue = values[Math.floor(values.length * 0.95)] || 100;
        }
        
        // Get filtered chromosomes
        const filteredChromosomes = this.getFilteredChromosomes();
        const filteredBins = new Set();
        filteredChromosomes.forEach(chr => {
            this.getChromosomeBins(chr).forEach(bin => filteredBins.add(bin));
        });
        
        // Draw heatmap
        for (let i = 0; i < size; i++) {
            for (let j = 0; j < size; j++) {
                const binI = order[i];
                const binJ = order[j];
                
                // Skip if either bin is from a filtered chromosome
                if (!filteredBins.has(binI) || !filteredBins.has(binJ)) continue;
                
                const value = matrix[binI][binJ];
                if (value > 0) {
                    ctx.fillStyle = this.getColor(value, minValue, maxValue);
                    ctx.fillRect(i * cellSize, j * cellSize, Math.ceil(cellSize), Math.ceil(cellSize));
                }
            }
        }
        
        // Draw chromosome boundaries
        if (this.vizSettings.showGrid) {
            ctx.strokeStyle = '#6366f1';
            ctx.lineWidth = 2;
            
            let currentPos = 0;
            filteredChromosomes.forEach(chr => {
                const chrBins = this.getChromosomeBins(chr).length;
                currentPos += chrBins;
                
                if (currentPos < size) {
                    ctx.beginPath();
                    ctx.moveTo(currentPos * cellSize, 0);
                    ctx.lineTo(currentPos * cellSize, canvas.height);
                    ctx.moveTo(0, currentPos * cellSize);
                    ctx.lineTo(canvas.width, currentPos * cellSize);
                    ctx.stroke();
                }
            });
        }
        
        // Draw diagonal
        if (this.vizSettings.showDiagonal) {
            ctx.strokeStyle = '#ec4899';
            ctx.lineWidth = 1;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(canvas.width, canvas.height);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        
        // Draw selection overlays
        this.drawSelections();
    }
    
    drawSelections() {
        const canvas = document.getElementById('heatmap-canvas');
        const ctx = canvas.getContext('2d');
        const cellSize = canvas.width / this.currentState.matrix.length;
        
        // Draw first selection
        if (this.selection) {
            ctx.strokeStyle = '#ec4899';
            ctx.lineWidth = 3;
            ctx.strokeRect(
                this.selection.x * cellSize,
                this.selection.y * cellSize,
                this.selection.width * cellSize,
                this.selection.height * cellSize
            );
            
            // Fill with semi-transparent overlay
            ctx.fillStyle = 'rgba(236, 72, 153, 0.2)';
            ctx.fillRect(
                this.selection.x * cellSize,
                this.selection.y * cellSize,
                this.selection.width * cellSize,
                this.selection.height * cellSize
            );
        }
        
        // Draw second selection for operations that need it
        if (this.secondSelection) {
            ctx.strokeStyle = '#10b981';
            ctx.lineWidth = 3;
            ctx.strokeRect(
                this.secondSelection.x * cellSize,
                this.secondSelection.y * cellSize,
                this.secondSelection.width * cellSize,
                this.secondSelection.height * cellSize
            );
            
            // Fill with semi-transparent overlay
            ctx.fillStyle = 'rgba(16, 185, 129, 0.2)';
            ctx.fillRect(
                this.secondSelection.x * cellSize,
                this.secondSelection.y * cellSize,
                this.secondSelection.width * cellSize,
                this.secondSelection.height * cellSize
            );
        }
    }
    
    renderPsPlot() {
        const canvas = document.getElementById('ps-plot');
        const ctx = canvas.getContext('2d');
        const psData = this.currentState.psData;
        
        if (!psData || !psData.data.length) return;
        
        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;
        
        // Clear canvas
        ctx.fillStyle = '#334155';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        const padding = 40;
        const plotWidth = canvas.width - 2 * padding;
        const plotHeight = canvas.height - 2 * padding;
        
        const xMin = Math.log10(1);
        const xMax = Math.log10(Math.max(...psData.data.map(d => d.s)));
        const yMin = Math.log10(Math.min(...psData.data.filter(d => d.p > 0).map(d => d.p)));
        const yMax = Math.log10(Math.max(...psData.data.map(d => d.p)));
        
        // Draw axes
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padding, padding);
        ctx.lineTo(padding, canvas.height - padding);
        ctx.lineTo(canvas.width - padding, canvas.height - padding);
        ctx.stroke();
        
        // Draw data points
        ctx.fillStyle = '#6366f1';
        psData.data.forEach(point => {
            if (point.p > 0) {
                const x = padding + (Math.log10(point.s) - xMin) / (xMax - xMin) * plotWidth;
                const y = canvas.height - padding - (Math.log10(point.p) - yMin) / (yMax - yMin) * plotHeight;
                
                ctx.beginPath();
                ctx.arc(x, y, 3, 0, 2 * Math.PI);
                ctx.fill();
            }
        });
        
        // Draw power law fit
        ctx.strokeStyle = '#ec4899';
        ctx.lineWidth = 2;
        ctx.beginPath();
        
        for (let i = 0; i <= 100; i++) {
            const logS = xMin + (xMax - xMin) * i / 100;
            const s = Math.pow(10, logS);
            const p = 100 * Math.pow(s, -psData.alpha);
            
            if (p > 0) {
                const x = padding + (logS - xMin) / (xMax - xMin) * plotWidth;
                const y = canvas.height - padding - (Math.log10(p) - yMin) / (yMax - yMin) * plotHeight;
                
                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }
        }
        ctx.stroke();
    }
    
    getChromosomeBins(chr) {
        const bins = [];
        this.contactMap.binMap.forEach((binId, key) => {
            if (key.startsWith(chr + ':')) {
                bins.push(binId);
            }
        });
        return bins.sort((a, b) => a - b);
    }
    
    handleMouseDown(e) {
        if (!this.currentState) return;
        
        const canvas = e.target;
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) * (canvas.width / rect.width);
        const y = (e.clientY - rect.top) * (canvas.height / rect.height);
        
        const cellSize = canvas.width / this.currentState.matrix.length;
        const binX = Math.floor(x / cellSize);
        const binY = Math.floor(y / cellSize);
        
        if (this.selectedTool === 'select') {
            this.selection = {
                startX: binX,
                startY: binY,
                endX: binX,
                endY: binY
            };
            this.isDragging = true;
        } else if (this.requiresTwoSelections()) {
            // Handle tools that need two selections
            if (this.operationStep === 0) {
                // First selection
                this.selection = {
                    startX: binX,
                    startY: binY,
                    endX: binX,
                    endY: binY
                };
                this.isDragging = true;
            } else if (this.operationStep === 1) {
                // Second selection
                this.secondSelection = {
                    startX: binX,
                    startY: binY,
                    endX: binX,
                    endY: binY
                };
                this.isDragging = true;
            }
        } else {
            // Single selection tools
            this.selection = {
                startX: binX,
                startY: binY,
                endX: binX,
                endY: binY
            };
            this.isDragging = true;
        }
    }
    
    requiresTwoSelections() {
        return ['move', 'swap', 'fuse'].includes(this.selectedTool);
    }
    
    handleMouseMove(e) {
        const canvas = e.target;
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) * (canvas.width / rect.width);
        const y = (e.clientY - rect.top) * (canvas.height / rect.height);
        
        const cellSize = canvas.width / this.currentState.matrix.length;
        const binX = Math.floor(x / cellSize);
        const binY = Math.floor(y / cellSize);
        
        // Update hover info
        if (binX >= 0 && binX < this.currentState.matrix.length && 
            binY >= 0 && binY < this.currentState.matrix.length) {
            const value = this.currentState.matrix[this.currentState.binOrder[binX]][this.currentState.binOrder[binY]];
            
            const hoverInfo = document.getElementById('hover-info');
            hoverInfo.style.display = 'block';
            hoverInfo.style.left = (e.clientX - rect.left + 10) + 'px';
            hoverInfo.style.top = (e.clientY - rect.top + 10) + 'px';
            
            const realBinX = this.currentState.binOrder[binX];
            const realBinY = this.currentState.binOrder[binY];
            
            // Find chromosome for bins
            let chrX = '', chrY = '';
            let accumBins = 0;
            for (const chr of this.chromosomes) {
                const chrBinCount = this.getChromosomeBins(chr).length;
                if (realBinX >= accumBins && realBinX < accumBins + chrBinCount) {
                    chrX = chr;
                }
                if (realBinY >= accumBins && realBinY < accumBins + chrBinCount) {
                    chrY = chr;
                }
                accumBins += chrBinCount;
            }
            
            hoverInfo.querySelector('.hover-coords').textContent = `${chrX}:${binX} × ${chrY}:${binY}`;
            hoverInfo.querySelector('.hover-value').textContent = `Value: ${value.toFixed(2)}`;
        }
        
        // Update selection if dragging
        if (this.isDragging) {
            if (this.operationStep === 1 && this.secondSelection) {
                this.secondSelection.endX = binX;
                this.secondSelection.endY = binY;
            } else if (this.selection) {
                this.selection.endX = binX;
                this.selection.endY = binY;
            }
            this.render();
        }
    }
    
    handleMouseUp(e) {
        if (this.isDragging) {
            this.isDragging = false;
            
            if (this.operationStep === 1 && this.secondSelection) {
                this.normalizeSelection(this.secondSelection);
            } else {
                this.normalizeSelection(this.selection);
            }
            
            if (this.requiresTwoSelections()) {
                if (this.operationStep === 0) {
                    this.operationStep = 1;
                    this.updateRegionInfo();
                } else if (this.operationStep === 1) {
                    this.updateRegionInfo();
                    this.showOperationConfirmation();
                }
            } else if (this.selectedTool !== 'select') {
                this.updateRegionInfo();
                this.showOperationConfirmation();
            } else {
                this.updateRegionInfo();
            }
            
            this.render();
        }
    }
    
    hideHoverInfo() {
        document.getElementById('hover-info').style.display = 'none';
    }
    
    normalizeSelection(sel) {
        if (!sel) return;
        
        const minX = Math.min(sel.startX, sel.endX);
        const maxX = Math.max(sel.startX, sel.endX);
        const minY = Math.min(sel.startY, sel.endY);
        const maxY = Math.max(sel.startY, sel.endY);
        
        sel.x = minX;
        sel.y = minY;
        sel.width = maxX - minX + 1;
        sel.height = maxY - minY + 1;
    }
    
    showOperationConfirmation() {
        document.getElementById('operation-controls').style.display = 'flex';
    }
    
    resetOperation() {
        this.selection = null;
        this.secondSelection = null;
        this.operationStep = 0;
        this.pendingOperation = null;
        document.getElementById('operation-controls').style.display = 'none';
        this.updateRegionInfo();
        this.render();
    }
    
    updateRegionInfo() {
        const regionInfo = document.getElementById('region-info');
        
        if (!this.selection && !this.secondSelection) {
            regionInfo.innerHTML = '<p style="color: var(--text-tertiary);">No region selected</p>';
            document.getElementById('operation-controls').style.display = 'none';
            return;
        }
        
        let html = '';
        
        // Show first selection
        if (this.selection) {
            const startBin = this.currentState.binOrder[this.selection.x];
            const endBin = this.currentState.binOrder[this.selection.x + this.selection.width - 1];
            
            let chrInfo = '';
            let accumBins = 0;
            for (const chr of this.chromosomes) {
                const chrBins = this.getChromosomeBins(chr);
                const chrStart = accumBins;
                const chrEnd = accumBins + chrBins.length;
                
                if (startBin >= chrStart && startBin < chrEnd) {
                    chrInfo = `${chr} (bins ${this.selection.x}-${this.selection.x + this.selection.width - 1})`;
                    break;
                }
                accumBins += chrBins.length;
            }
            
            html += `
                <h4>Selection 1 <span style="color: #ec4899;">(Pink)</span></h4>
                <div class="region-details">
                    <div>Position: ${this.selection.x}, ${this.selection.y}</div>
                    <div>Size: ${this.selection.width} × ${this.selection.height}</div>
                    <div>Chromosome: ${chrInfo}</div>
                </div>
            `;
        }
        
        // Show second selection if exists
        if (this.secondSelection) {
            const startBin = this.currentState.binOrder[this.secondSelection.x];
            const endBin = this.currentState.binOrder[this.secondSelection.x + this.secondSelection.width - 1];
            
            let chrInfo = '';
            let accumBins = 0;
            for (const chr of this.chromosomes) {
                const chrBins = this.getChromosomeBins(chr);
                const chrStart = accumBins;
                const chrEnd = accumBins + chrBins.length;
                
                if (startBin >= chrStart && startBin < chrEnd) {
                    chrInfo = `${chr} (bins ${this.secondSelection.x}-${this.secondSelection.x + this.secondSelection.width - 1})`;
                    break;
                }
                accumBins += chrBins.length;
            }
            
            html += `
                <h4 style="margin-top: 1rem;">Selection 2 <span style="color: #10b981;">(Green)</span></h4>
                <div class="region-details">
                    <div>Position: ${this.secondSelection.x}, ${this.secondSelection.y}</div>
                    <div>Size: ${this.secondSelection.width} × ${this.secondSelection.height}</div>
                    <div>Chromosome: ${chrInfo}</div>
                </div>
            `;
        }
        
        // Show operation instructions
        if (this.requiresTwoSelections() && this.operationStep === 0) {
            html += `
                <div style="margin-top: 1rem; padding: 0.75rem; background: var(--warning); color: black; border-radius: 6px;">
                    <strong>Step 1 of 2:</strong> Select the first region for ${this.selectedTool} operation
                </div>
            `;
        } else if (this.requiresTwoSelections() && this.operationStep === 1 && !this.secondSelection) {
            html += `
                <div style="margin-top: 1rem; padding: 0.75rem; background: var(--success); color: black; border-radius: 6px;">
                    <strong>Step 2 of 2:</strong> Select the second region for ${this.selectedTool} operation
                </div>
            `;
        }
        
        regionInfo.innerHTML = html;
    }
    
    confirmOperation() {
        switch (this.selectedTool) {
            case 'move':
                this.performMove();
                break;
            case 'swap':
                this.performSwap();
                break;
            case 'invert':
                this.performInversion();
                break;
            case 'delete':
                this.performDeletion();
                break;
            case 'duplicate':
                this.performDuplication();
                break;
            case 'split':
                this.performSplit();
                break;
            case 'fuse':
                this.performFusion();
                break;
        }
        
        this.resetOperation();
    }
    
    cancelOperation() {
        this.resetOperation();
    }
    
    performMove() {
        if (!this.selection || !this.secondSelection) return;
        
        const startX = this.selection.x;
        const width = this.selection.width;
        const targetX = this.secondSelection.x;
        
        const movedBins = this.currentState.binOrder.splice(startX, width);
        const insertPos = targetX > startX ? targetX - width : targetX;
        this.currentState.binOrder.splice(insertPos, 0, ...movedBins);
        
        this.calculatePsDistribution();
        this.calculateScore();
        this.saveToHistory(`Move ${width} bins from ${startX} to ${targetX}`);
        
        this.render();
    }
    
    performSwap() {
        if (!this.selection || !this.secondSelection) return;
        
        const order = this.currentState.binOrder;
        
        // Extract regions
        const bins1 = order.slice(this.selection.x, this.selection.x + this.selection.width);
        const bins2 = order.slice(this.secondSelection.x, this.secondSelection.x + this.secondSelection.width);
        
        // Perform swap
        if (this.selection.x < this.secondSelection.x) {
            order.splice(this.secondSelection.x, this.secondSelection.width, ...bins1);
            order.splice(this.selection.x, this.selection.width, ...bins2);
        } else {
            order.splice(this.selection.x, this.selection.width, ...bins2);
            order.splice(this.secondSelection.x, this.secondSelection.width, ...bins1);
        }
        
        this.calculatePsDistribution();
        this.calculateScore();
        this.saveToHistory(`Swap regions ${this.selection.x}-${this.selection.x + this.selection.width} and ${this.secondSelection.x}-${this.secondSelection.x + this.secondSelection.width}`);
        
        this.render();
    }
    
    performInversion() {
        if (!this.selection) return;
        
        const startX = this.selection.x;
        const width = this.selection.width;
        
        const invertedBins = this.currentState.binOrder.slice(startX, startX + width).reverse();
        this.currentState.binOrder.splice(startX, width, ...invertedBins);
        
        this.calculatePsDistribution();
        this.calculateScore();
        this.saveToHistory(`Invert ${width} bins at position ${startX}`);
        
        this.render();
    }
    
    performDeletion() {
        if (!this.selection) return;
        
        const startX = this.selection.x;
        const width = this.selection.width;
        
        this.currentState.binOrder.splice(startX, width);
        
        this.calculatePsDistribution();
        this.calculateScore();
        this.saveToHistory(`Delete ${width} bins at position ${startX}`);
        
        this.render();
    }
    
    performDuplication() {
        if (!this.selection) return;
        
        const startX = this.selection.x;
        const width = this.selection.width;
        
        const duplicatedBins = this.currentState.binOrder.slice(startX, startX + width);
        this.currentState.binOrder.splice(startX + width, 0, ...duplicatedBins);
        
        this.calculatePsDistribution();
        this.calculateScore();
        this.saveToHistory(`Duplicate ${width} bins at position ${startX}`);
        
        this.render();
    }
    
    performSplit() {
        if (!this.selection) return;
        
        // This is a placeholder - actual implementation would need to update chromosome boundaries
        alert('Split operation would create new chromosome boundary at position ' + this.selection.x);
    }
    
    performFusion() {
        if (!this.selection || !this.secondSelection) return;
        
        // This is a placeholder - actual implementation would need to merge chromosome boundaries
        alert('Fusion operation would merge chromosomes between the selected regions');
    }
    
    exportBed() {
        if (!this.currentState || !this.contactMap) {
            alert('No data to export');
            return;
        }
        
        const output = [];
        output.push('# Reassembled contact map');
        output.push('# Score: ' + this.currentState.score.toFixed(2));
        output.push('# Power law alpha: ' + (this.currentState.psData?.alpha.toFixed(3) || 'N/A'));
        output.push('# chr1\tstart1\tend1\tchr2\tstart2\tend2\tscore');
        
        // Export reordered matrix
        const order = this.currentState.binOrder;
        const matrix = this.currentState.matrix;
        
        for (let i = 0; i < order.length; i++) {
            for (let j = i; j < order.length; j++) {
                if (matrix[order[i]][order[j]] > 0) {
                    output.push(`bin${i}\t${i * this.binSize}\t${(i + 1) * this.binSize}\tbin${j}\t${j * this.binSize}\t${(j + 1) * this.binSize}\t${matrix[order[i]][order[j]].toFixed(2)}`);
                }
            }
        }
        
        this.downloadFile('reassembled_contacts.bed', output.join('\n'));
    }
    
    exportModifications() {
        const output = ['# Genome Reassembly Modification History'];
        output.push(`# Total modifications: ${this.history.length}`);
        output.push(`# Best score achieved: ${Math.max(...this.history.map(h => h.state.score))}`);
        output.push('');
        
        this.history.forEach((item, idx) => {
            output.push(`\nStep ${idx + 1}: ${item.description}`);
            output.push(`  Timestamp: ${new Date(item.timestamp).toLocaleString()}`);
            output.push(`  Score: ${item.state.score.toFixed(2)}`);
            output.push(`  Power law alpha: ${item.state.psAlpha?.toFixed(3) || 'N/A'}`);
        });
        
        this.downloadFile('modification_history.txt', output.join('\n'));
    }
    
    exportFasta() {
        if (!this.fastaData) {
            alert('No FASTA data loaded');
            return;
        }
        
        const output = [];
        output.push('; Reassembled genome');
        output.push('; Score: ' + this.currentState.score.toFixed(2));
        
        Object.entries(this.fastaData).forEach(([chr, seq]) => {
            output.push(`>${chr}_reassembled`);
            for (let i = 0; i < seq.length; i += 80) {
                output.push(seq.slice(i, i + 80));
            }
        });
        
        this.downloadFile('reassembled_genome.fasta', output.join('\n'));
    }
    
    exportMatrix() {
        if (!this.currentState) {
            alert('No data to export');
            return;
        }
        
        const order = this.currentState.binOrder;
        const matrix = this.currentState.matrix;
        const output = [];
        
        for (let i = 0; i < order.length; i++) {
            const row = [];
            for (let j = 0; j < order.length; j++) {
                row.push(matrix[order[i]][order[j]].toFixed(2));
            }
            output.push(row.join('\t'));
        }
        
        this.downloadFile('reassembled_matrix.tsv', output.join('\n'));
    }
    
    downloadFile(filename, content) {
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    showLoading() {
        document.getElementById('loading').style.display = 'flex';
    }
    
    hideLoading() {
        document.getElementById('loading').style.display = 'none';
    }
}

// Initialize the tool
document.addEventListener('DOMContentLoaded', () => {
    window.genomeReassemblyTool = new GenomeReassemblyTool();
});