#!/usr/bin/env node
/**
 * Process GitHub Actions jobs into dashboard format
 * 
 * Reads: raw-runs.json (contains jobs), config.yaml, job-logs/*.log, data.json (cache)
 * Outputs: data.json
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

console.log('Starting data processing...');

// Load config
let config;
try {
  config = yaml.load(fs.readFileSync('config.yaml', 'utf8'));
  console.log('Config loaded successfully');
} catch (e) {
  console.error('Failed to load config.yaml:', e.message);
  process.exit(1);
}

// Load existing data.json as cache (if exists)
let cachedData = null;
try {
  if (fs.existsSync('data.json')) {
    cachedData = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    console.log(`Loaded cached data from ${cachedData.lastRefresh || 'unknown time'}`);
    console.log(`  Cache has ${cachedData.sections?.length || 0} sections`);
    
    // Also load cached failed tests index if exists
    if (cachedData.failedTestsIndex) {
      console.log(`  Cache has ${Object.keys(cachedData.failedTestsIndex).length} tracked failed tests`);
    }
  }
} catch (e) {
  console.warn('No cached data available:', e.message);
}

// Load raw jobs data
let rawData;
try {
  rawData = JSON.parse(fs.readFileSync('raw-runs.json', 'utf8'));
  console.log(`Loaded ${rawData.jobs?.length || 0} jobs`);
} catch (e) {
  console.error('Failed to load raw-runs.json:', e.message);
  process.exit(1);
}

const allJobs = rawData.jobs || [];

// Load job logs for failed jobs
const jobLogs = {};
const logsDir = 'job-logs';
if (fs.existsSync(logsDir)) {
  const logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
  console.log(`Found ${logFiles.length} job log files`);
  
  logFiles.forEach(file => {
    const jobId = file.replace('.log', '');
    try {
      const content = fs.readFileSync(path.join(logsDir, file), 'utf8');
      jobLogs[jobId] = content;
    } catch (e) {
      console.warn(`Could not read log for job ${jobId}: ${e.message}`);
    }
  });
}

/**
 * Parse job logs to extract test failure details from TAP output
 */
function parseTestFailures(jobId) {
  const log = jobLogs[jobId];
  if (!log) return null;
  
  const failures = [];
  const lines = log.split('\n');
  
  let inReportTests = false;
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  let skippedTests = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Detect "Report tests" section
    if (line.includes('Report tests') || line.includes('##[group]Report')) {
      inReportTests = true;
      continue;
    }
    
    // End of section
    if (inReportTests && (line.includes('##[endgroup]') || line.includes('Post '))) {
      break;
    }
    
    if (!inReportTests) continue;
    
    // Parse TAP output
    // "not ok 1 - Test name # TODO skip reason" or "not ok 1 - Test name"
    const notOkMatch = line.match(/not ok (\d+) - (.+?)(?:\s*#\s*(.*))?$/);
    if (notOkMatch) {
      failedTests++;
      totalTests++;
      const testNumber = notOkMatch[1];
      const testName = notOkMatch[2].trim();
      const comment = notOkMatch[3] || '';
      
      // Check if it's a skip/todo
      if (comment.toLowerCase().includes('skip') || comment.toLowerCase().includes('todo')) {
        skippedTests++;
        failedTests--;
      } else {
        failures.push({
          number: parseInt(testNumber),
          name: testName,
          comment: comment
        });
      }
      continue;
    }
    
    // "ok 1 - Test name"
    const okMatch = line.match(/ok (\d+) - (.+?)(?:\s*#\s*(.*))?$/);
    if (okMatch) {
      passedTests++;
      totalTests++;
      continue;
    }
    
    // TAP plan "1..N"
    const planMatch = line.match(/^1\.\.(\d+)/);
    if (planMatch) {
      // This tells us the expected number of tests
      continue;
    }
  }
  
  if (failures.length === 0 && totalTests === 0) {
    return null;
  }
  
  return {
    failures: failures,
    stats: {
      total: totalTests,
      passed: passedTests,
      failed: failedTests,
      skipped: skippedTests
    }
  };
}

// Debug: Print all unique job names
const uniqueJobNames = [...new Set(allJobs.map(j => j.name))];
console.log(`\nUnique job names in data (${uniqueJobNames.length} total):`);
uniqueJobNames.forEach(name => {
  if (name.toLowerCase().includes('nvidia') || name.toLowerCase().includes('gpu') ||
      name.toLowerCase().includes('coco') || name.toLowerCase().includes('tee')) {
    console.log(`  [MATCH] ${name}`);
  }
});

// Get the job names we care about from config
const configuredJobs = [];
(config.sections || []).forEach(section => {
  (section.jobs || []).forEach(job => {
    const jobName = typeof job === 'string' ? job : job.name;
    const jobDesc = typeof job === 'object' ? job.description : jobName;
    configuredJobs.push({ name: jobName, description: jobDesc, section: section.id });
  });
});

console.log('Configured jobs to monitor:', configuredJobs.map(j => j.name));

/**
 * Global index of failed tests across all jobs
 * Structure: { "testName": { occurrences: [{date, jobName, jobId, runId}], totalCount: N } }
 */
const failedTestsIndex = cachedData?.failedTestsIndex || {};

/**
 * Merge new failure data into the global index
 */
function indexFailedTest(testName, date, jobName, jobId, runId) {
  if (!failedTestsIndex[testName]) {
    failedTestsIndex[testName] = {
      occurrences: [],
      totalCount: 0
    };
  }
  
  // Check if this occurrence already exists (by jobId)
  const existingIdx = failedTestsIndex[testName].occurrences.findIndex(
    o => o.jobId === jobId
  );
  
  if (existingIdx === -1) {
    failedTestsIndex[testName].occurrences.push({
      date: date,
      jobName: jobName,
      jobId: jobId,
      runId: runId
    });
    failedTestsIndex[testName].totalCount++;
  }
  
  // Keep only last 30 days of data
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 30);
  
  failedTestsIndex[testName].occurrences = failedTestsIndex[testName].occurrences
    .filter(o => new Date(o.date) >= cutoffDate)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  
  failedTestsIndex[testName].totalCount = failedTestsIndex[testName].occurrences.length;
}

/**
 * Get cached weather history for a test if it exists
 */
function getCachedWeatherHistory(sectionId, testId) {
  if (!cachedData) return null;
  const section = cachedData.sections?.find(s => s.id === sectionId);
  if (!section) return null;
  const test = section.tests?.find(t => t.id === testId);
  return test?.weatherHistory || null;
}

// Process sections based on config
const sections = (config.sections || []).map(sectionConfig => {
  const sectionJobs = sectionConfig.jobs || [];
  
  const tests = sectionJobs.map(jobConfig => {
    const jobName = typeof jobConfig === 'string' ? jobConfig : jobConfig.name;
    const jobDescription = typeof jobConfig === 'object' ? jobConfig.description : jobName;
    // Use description as display name, fall back to job name
    const displayName = jobDescription || jobName;
    const testId = displayName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    
    // Find jobs matching this name (exact match)
    const matchingJobs = allJobs.filter(job => {
      const name = job.name || '';
      // Exact match for full job name
      return name === jobName;
    }).sort((a, b) => new Date(b.started_at || b.created_at) - new Date(a.started_at || a.created_at));
    
    console.log(`Job "${displayName}": found ${matchingJobs.length} matching jobs`);
    if (matchingJobs.length > 0) {
      console.log(`  Latest: ${matchingJobs[0].name} - ${matchingJobs[0].conclusion}`);
    }
    
    // Get latest job
    const latestJob = matchingJobs[0];
    
    let status = 'not_run';
    if (latestJob) {
      if (latestJob.status === 'in_progress' || latestJob.status === 'queued') {
        status = 'running';
      } else if (latestJob.conclusion === 'success') {
        status = 'passed';
      } else if (latestJob.conclusion === 'failure') {
        status = 'failed';
      } else if (latestJob.conclusion === 'cancelled' || latestJob.conclusion === 'skipped') {
        status = 'not_run';
      }
    }
    
    // Get cached weather for this test
    const cachedWeather = getCachedWeatherHistory(sectionConfig.id, testId);
    
    // Build weather history (last 10 days)
    const weatherHistory = [];
    for (let i = 0; i < 10; i++) {
      const date = new Date();
      date.setDate(date.getDate() - (9 - i));
      date.setHours(0, 0, 0, 0);
      
      const dayJob = matchingJobs.find(job => {
        const jobDate = new Date(job.started_at || job.created_at);
        return jobDate.toDateString() === date.toDateString();
      });
      
      let dayStatus = 'none';
      let dayFailures = null;
      
      if (dayJob) {
        if (dayJob.conclusion === 'success') {
          dayStatus = 'passed';
        } else if (dayJob.conclusion === 'failure') {
          dayStatus = 'failed';
          
          // Try to get failure details
          dayFailures = parseTestFailures(dayJob.id.toString());
          
          // If no fresh log, try to get from cache
          if (!dayFailures && cachedWeather) {
            const cachedDay = cachedWeather.find(c => 
              new Date(c.date).toDateString() === date.toDateString()
            );
            if (cachedDay?.failureDetails) {
              dayFailures = cachedDay.failureDetails;
            }
          }
          
          // Index the failed tests
          if (dayFailures?.failures) {
            dayFailures.failures.forEach(f => {
              indexFailedTest(
                f.name,
                date.toISOString(),
                displayName,
                dayJob.id.toString(),
                dayJob.workflow_run_id || dayJob.run_id?.toString()
              );
            });
          }
        }
      } else if (cachedWeather) {
        // No fresh data for this day, use cache if available
        const cachedDay = cachedWeather.find(c => 
          new Date(c.date).toDateString() === date.toDateString()
        );
        if (cachedDay) {
          dayStatus = cachedDay.status;
          dayFailures = cachedDay.failureDetails;
        }
      }
      
      weatherHistory.push({
        date: date.toISOString(),
        status: dayStatus,
        runId: dayJob?.workflow_run_id || dayJob?.run_id?.toString() || null,
        jobId: dayJob?.id?.toString() || null,
        duration: dayJob ? formatDuration(dayJob.started_at, dayJob.completed_at) : null,
        failureStep: dayStatus === 'failed' ? getFailedStep(dayJob) : null,
        failureDetails: dayFailures
      });
    }
    
    // Count failures in last 10 days
    const failureCount = weatherHistory.filter(w => w.status === 'failed').length;
    
    // Get all unique failed tests from weather history
    const failedTestsInWeather = [];
    weatherHistory.forEach(day => {
      if (day.failureDetails?.failures) {
        day.failureDetails.failures.forEach(f => {
          const existing = failedTestsInWeather.find(e => e.name === f.name);
          if (existing) {
            existing.count++;
            existing.dates.push(day.date);
          } else {
            failedTestsInWeather.push({
              name: f.name,
              count: 1,
              dates: [day.date]
            });
          }
        });
      }
    });
    
    // Sort by count descending
    failedTestsInWeather.sort((a, b) => b.count - a.count);
    
    // Find last failure and success
    const lastFailureJob = matchingJobs.find(j => j.conclusion === 'failure');
    const lastSuccessJob = matchingJobs.find(j => j.conclusion === 'success');
    
    // Get failure details for the latest failed job
    let errorDetails = null;
    if (status === 'failed' && latestJob?.id) {
      const testFailures = parseTestFailures(latestJob.id.toString());
      
      if (testFailures && testFailures.failures.length > 0) {
        errorDetails = {
          step: getFailedStep(latestJob),
          testResults: testFailures.stats,
          failures: testFailures.failures.slice(0, 20), // Limit to first 20 failures
          output: testFailures.failures.map(f => `not ok ${f.number} - ${f.name}${f.comment ? ' # ' + f.comment : ''}`).join('\n')
        };
      } else {
        errorDetails = {
          step: getFailedStep(latestJob),
          output: 'View full log on GitHub for details'
        };
      }
    }
    
    return {
      id: testId,
      name: displayName,
      fullName: jobName,
      status: status,
      duration: latestJob ? formatDuration(latestJob.started_at, latestJob.completed_at) : 'N/A',
      lastFailure: lastFailureJob ? formatRelativeTime(lastFailureJob.started_at) : 'Never',
      lastSuccess: lastSuccessJob ? formatRelativeTime(lastSuccessJob.started_at) : 'Never',
      weatherHistory: weatherHistory,
      failureCount: failureCount,
      failedTestsInWeather: failedTestsInWeather, // NEW: specific "not ok" tests and their frequency
      retried: latestJob?.run_attempt > 1 ? latestJob.run_attempt - 1 : 0,
      setupRetry: false,
      runId: latestJob?.workflow_run_id || latestJob?.run_id?.toString() || null,
      jobId: latestJob?.id?.toString() || null,
      error: errorDetails
    };
  });
  
  return {
    id: sectionConfig.id,
    name: sectionConfig.name,
    description: sectionConfig.description,
    maintainers: sectionConfig.maintainers || [],
    tests: tests
  };
});

/**
 * For each failed test in the index, find which other jobs also have this failure
 */
function enrichFailedTestsIndex() {
  Object.keys(failedTestsIndex).forEach(testName => {
    const entry = failedTestsIndex[testName];
    
    // Group by job name
    const jobBreakdown = {};
    entry.occurrences.forEach(occ => {
      if (!jobBreakdown[occ.jobName]) {
        jobBreakdown[occ.jobName] = {
          count: 0,
          dates: [],
          jobIds: []
        };
      }
      jobBreakdown[occ.jobName].count++;
      jobBreakdown[occ.jobName].dates.push(occ.date);
      jobBreakdown[occ.jobName].jobIds.push(occ.jobId);
    });
    
    entry.affectedJobs = Object.keys(jobBreakdown).map(jobName => ({
      jobName: jobName,
      count: jobBreakdown[jobName].count,
      latestDate: jobBreakdown[jobName].dates[0],
      jobIds: jobBreakdown[jobName].jobIds
    })).sort((a, b) => b.count - a.count);
    
    // Count unique jobs affected
    entry.uniqueJobsAffected = entry.affectedJobs.length;
  });
}

enrichFailedTestsIndex();

// Build output data
const outputData = {
  lastRefresh: new Date().toISOString(),
  sections: sections,
  failedTestsIndex: failedTestsIndex // NEW: global index of all failed tests
};

// Write data.json
fs.writeFileSync('data.json', JSON.stringify(outputData, null, 2));
console.log(`Written data.json with ${sections.length} sections`);
console.log(`Tracking ${Object.keys(failedTestsIndex).length} unique failed tests`);

// Log summary
sections.forEach(section => {
  const passed = section.tests.filter(t => t.status === 'passed').length;
  const failed = section.tests.filter(t => t.status === 'failed').length;
  const notRun = section.tests.filter(t => t.status === 'not_run').length;
  const running = section.tests.filter(t => t.status === 'running').length;
  console.log(`Section "${section.name}": ${passed} passed, ${failed} failed, ${running} running, ${notRun} not run`);
  
  // Log failure details if any
  section.tests.filter(t => t.failedTestsInWeather?.length > 0).forEach(t => {
    console.log(`  ${t.name}: ${t.failureCount} failures in 10 days`);
    t.failedTestsInWeather.slice(0, 3).forEach(f => {
      console.log(`    - "${f.name}" failed ${f.count}x`);
    });
  });
});

// Log top failing tests across all jobs
const topFailingTests = Object.entries(failedTestsIndex)
  .sort((a, b) => b[1].totalCount - a[1].totalCount)
  .slice(0, 10);

if (topFailingTests.length > 0) {
  console.log('\nTop failing tests across all jobs (last 30 days):');
  topFailingTests.forEach(([testName, data]) => {
    console.log(`  "${testName.substring(0, 60)}..." - ${data.totalCount}x across ${data.uniqueJobsAffected} job(s)`);
  });
}

console.log('Data processing complete!');

// Helper functions
function getFailedStep(job) {
  if (!job || !job.steps) return 'Unknown step';
  const failedStep = job.steps.find(s => s.conclusion === 'failure');
  return failedStep?.name || 'Run tests';
}

function formatDuration(startTime, endTime) {
  if (!startTime || !endTime) return 'N/A';
  const start = new Date(startTime);
  const end = new Date(endTime);
  const diffMs = end - start;
  if (isNaN(diffMs) || diffMs < 0) return 'N/A';
  const minutes = Math.floor(diffMs / 60000);
  const seconds = Math.floor((diffMs % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatRelativeTime(dateString) {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return 'N/A';
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours === 0) {
      return 'Just now';
    }
    return `${diffHours}h ago`;
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString();
  }
}

