import test from 'node:test';
import assert from 'node:assert/strict';
import { reportWrite, modelMetrics } from './harness-model-case.mjs';
const path='reports/summary.json';
const event=(name,args,isError=false)=>({event:'tool-result',name,arguments:args,isError});

test('planned, read and validation references are not summary writes',()=>{
    for(const entry of [
        event('todo_write',{todos:[{content:'新增 '+path,status:'pending'}]}),
        event('read',{file_path:path}),
        event('bash',{command:`node -e "JSON.parse(require('fs').readFileSync('${path}','utf8'))" && ls reports`}),
        event('bash',{command:`cat ${path} > reports/copy.json`}),
        event('write',{file_path:'reports/other.json',content:path}),
        event('write',{file_path:path,content:'{}'},true),
    ]) assert.equal(reportWrite(entry,path),false,entry.name+' '+JSON.stringify(entry.arguments));
});
test('successful native writes and exact shell mutation targets count',()=>{
    for(const entry of [
        event('write',{file_path:path,content:'{}'}),
        event('edit',{file_path:'/tmp/isolated/'+path,old_string:'a',new_string:'b'}),
        event('bash',{command:`cat <<'EOF' > ${path}\n{}\nEOF`}),
        event('bash',{command:`node -e "require('fs').writeFileSync('${path}','{}')"`}),
    ]) assert.equal(reportWrite(entry,path),true,entry.name+' '+JSON.stringify(entry.arguments));
});
test('metrics keep missing usage explicit and exclude purpose requests from headers',()=>{
    const metrics=modelMetrics([
        {event:'model-request',request:1,sessionId:'captain',systemSha256:'same',toolsSha256:'same'},
        {event:'model-request',request:2,sessionId:'captain',systemSha256:'same',toolsSha256:'same'},
        {event:'model-request',request:3,sessionId:'captain',purpose:'title',systemSha256:'different',toolsSha256:'different'},
        {event:'model-usage',request:1,usage:{inputTokens:10,cacheReadTokens:100}},
        {event:'model-usage',request:1,usage:{inputTokens:12,cacheReadTokens:100}},
    ],'captain');
    assert.equal(metrics.stableSessionHeaders,true);
    assert.deepEqual(metrics.requestsWithoutUsage,[2]);
    assert.equal(metrics.usage.uncachedInputTokens,12);
    assert.equal(metrics.usage.cacheWriteTokens,null);
});

test('metrics split captain and member usage, schemas, and native tool calls',()=>{
    const metrics=modelMetrics([
        {event:'model-request',request:1,sessionId:'captain',systemSha256:'c',toolsSha256:'c',systemBytes:40,toolsBytes:900,toolCount:11},
        {event:'model-request',request:2,sessionId:'member-1',systemSha256:'m',toolsSha256:'m',systemBytes:20,toolsBytes:500,toolCount:4},
        {event:'model-usage',request:1,usage:{inputTokens:100,outputTokens:30}},
        {event:'model-usage',request:2,usage:{inputTokens:60,outputTokens:10}},
        {event:'tool-result',sessionId:'captain',name:'agent_teams_create',isError:false},
        {event:'tool-result',sessionId:'member-1',name:'agent_teams_update_task',isError:false},
        {event:'tool-result',sessionId:'member-1',name:'agent_teams_update_task',isError:true},
    ],'captain');
    assert.deepEqual(metrics.byRole.captain,{requests:1,systemBytes:[40],toolSchemaBytes:[900],toolCounts:[11],toolCalls:1,successfulToolCalls:1,usage:{uncachedInputTokens:100,cacheReadTokens:null,cacheWriteTokens:null,outputTokens:30,reasoningTokens:null}});
    assert.deepEqual(metrics.byRole.member,{requests:1,systemBytes:[20],toolSchemaBytes:[500],toolCounts:[4],toolCalls:2,successfulToolCalls:1,usage:{uncachedInputTokens:60,cacheReadTokens:null,cacheWriteTokens:null,outputTokens:10,reasoningTokens:null}});
});
