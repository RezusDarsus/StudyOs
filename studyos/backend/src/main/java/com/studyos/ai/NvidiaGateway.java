package com.studyos.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** NVIDIA NIM's OpenAI-compatible chat endpoint. */
@Component
@ConditionalOnProperty(name = "studyos.ai.provider", havingValue = "nvidia")
public class NvidiaGateway implements AiGateway {
    private static final Logger log = LoggerFactory.getLogger(NvidiaGateway.class);
    private static final String NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
    private static final String NVIDIA_EMBEDDINGS_URL = "https://integrate.api.nvidia.com/v1/embeddings";
    private static final String DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";
    private static final int MAX_PROVIDER_ATTEMPTS = 4;
    private static final long BASE_RETRY_DELAY_MILLIS = 250;
    /**
     * Ceiling on one HTTP attempt. Every attempt gets its own timeout, so this bounds an attempt rather than
     * the call: the number of attempts no longer multiplies the wait, and {@link RequestDeadline} shortens it
     * further whenever the turn has less than this left.
     */
    private static final Duration PER_ATTEMPT_TIMEOUT = Duration.ofMinutes(2);
    /** Held back from any backoff sleep so the attempt it is waiting for still has room to run. */
    private static final Duration ATTEMPT_RESERVE = Duration.ofSeconds(2);
    private final String key; private final String model; private final String embeddingModel; private final int maxTokens; private final boolean thinking; private final ObjectMapper mapper; private final HttpClient client; private final StructuredOutputNormalizer structuredNormalizer;
    public NvidiaGateway(@Value("${NVIDIA_API_KEY:}") String key, @Value("${STUDYOS_AI_CHAT_MODEL:nvidia/nemotron-3-super-120b-a12b}") String model, @Value("${STUDYOS_AI_EMBEDDING_MODEL:nvidia/nemotron-3-embed-1b}") String embeddingModel, @Value("${STUDYOS_AI_MAX_TOKENS:2048}") int maxTokens, @Value("${STUDYOS_AI_THINKING:false}") boolean thinking, ObjectMapper mapper) { this.key=key; this.model=model.isBlank()?DEFAULT_MODEL:model; this.embeddingModel=embeddingModel; this.maxTokens=maxTokens; this.thinking=thinking; this.mapper=mapper; this.structuredNormalizer=new StructuredOutputNormalizer(mapper); this.client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build(); }
    @Override public AiResult<float[]> embedResult(String text,EmbeddingInputType inputType) { AiResult<java.util.List<float[]>> batch=embedBatchResult(java.util.List.of(text),inputType); return new AiResult<>(batch.value().getFirst(),batch.inputTokens(),batch.outputTokens(),batch.totalTokens(),batch.model()); }
    @Override public AiResult<java.util.List<float[]>> embedBatchResult(java.util.List<String> texts,EmbeddingInputType inputType) { try { if (texts.isEmpty()) return AiResult.withoutUsage(java.util.List.of(), embeddingModel); var body=embeddingBody(texts,inputType); JsonNode response=post(NVIDIA_EMBEDDINGS_URL,body,embeddingModel); var result=new java.util.ArrayList<float[]>(); for(JsonNode item:response.path("data")){ JsonNode values=item.path("embedding"); float[] vector=new float[values.size()]; for(int i=0;i<vector.length;i++) vector[i]=(float)values.get(i).asDouble(); result.add(vector); } if(result.size()!=texts.size()) throw new AiProviderException("NVIDIA",null,false,"NVIDIA returned an unexpected embedding count"); return result(response,result,embeddingModel); } catch(AiProviderException e){ throw e; } catch(Exception e){ throw new AiProviderException("NVIDIA",null,true,"NVIDIA embedding request failed",e); } }
    JsonNode embeddingBody(java.util.List<String> texts,EmbeddingInputType inputType){var body=mapper.createObjectNode().put("model",embeddingModel).put("input_type",inputType.providerValue()).put("encoding_format","float").put("truncate","END");var input=body.putArray("input");texts.forEach(input::add);return body;}
    @Override public AiResult<String> generateResult(String systemPrompt, String userPrompt) { try { var body=generationBody(model,1.0,.95,maxTokens,thinking,systemPrompt,userPrompt); var response=post(NVIDIA_URL,body,model); return result(response,response.path("choices").get(0).path("message").path("content").asText(),model); } catch(AiProviderException e){ throw e; } catch(Exception e){ throw new AiProviderException("NVIDIA",null,true,"NVIDIA AI request failed",e); } }
    @Override public AiResult<String> generateResult(String systemPrompt, String userPrompt, GenerationPolicy policy) { try { String selectedModel=policy.model()==null||policy.model().isBlank()?model:policy.model(); var body=generationBody(selectedModel,policy.temperature(),policy.topP(),policy.maxOutputTokens(),policy.thinking(),policy.responseMode(),systemPrompt,userPrompt); var response=post(NVIDIA_URL,body,selectedModel); return result(response,response.path("choices").get(0).path("message").path("content").asText(),selectedModel); } catch(AiProviderException e){ throw e; } catch(Exception e){ throw new AiProviderException("NVIDIA",null,true,"NVIDIA AI request failed",e); } }
    JsonNode generationBody(String selectedModel,double temperature,double topP,int outputCap,boolean enableThinking,String systemPrompt,String userPrompt){return generationBody(selectedModel,temperature,topP,outputCap,enableThinking,GenerationPolicy.ResponseMode.TEXT,systemPrompt,userPrompt);}
    JsonNode generationBody(String selectedModel,double temperature,double topP,int outputCap,boolean enableThinking,GenerationPolicy.ResponseMode responseMode,String systemPrompt,String userPrompt){var body=mapper.createObjectNode().put("model",selectedModel).put("temperature",temperature).put("top_p",topP).put("max_tokens",outputCap).put("stream",false);body.putObject("chat_template_kwargs").put("enable_thinking",enableThinking);if(enableThinking)body.put("reasoning_budget",Math.min(outputCap,2048));if(responseMode==GenerationPolicy.ResponseMode.JSON)body.putObject("response_format").put("type","json_object");var messages=body.putArray("messages");messages.addObject().put("role","system").put("content",systemPrompt);messages.addObject().put("role","user").put("content",userPrompt);return body;}
    @Override public <T> AiResult<T> generateStructuredResult(String systemPrompt,String userPrompt,Class<T> responseType){ GenerationPolicy policy=new GenerationPolicy(AiOperation.CHAT,model,maxTokens,.1,1,false,GenerationPolicy.ResponseMode.JSON);return generateStructuredResult(systemPrompt,userPrompt,responseType,policy); }
    @Override public <T> AiResult<T> generateStructuredResult(String systemPrompt,String userPrompt,Class<T> responseType,GenerationPolicy policy){ GenerationPolicy jsonPolicy=new GenerationPolicy(policy.operation(),policy.model(),policy.maxOutputTokens(),policy.temperature(),policy.topP(),policy.thinking(),GenerationPolicy.ResponseMode.JSON); AiResult<String> raw=generateResult(systemPrompt+StructuredPrompts.jsonOnly(),userPrompt,jsonPolicy); return StructuredGenerationSupport.parseStructured(mapper,this::generateResult,jsonPolicy,raw,responseType,structuredNormalizer); }
    private <T> AiResult<T> result(JsonNode response,T value,String fallbackModel) { JsonNode usage=response.path("usage"); Integer input=usage.has("prompt_tokens")?usage.get("prompt_tokens").asInt():null; Integer output=usage.has("completion_tokens")?usage.get("completion_tokens").asInt():null; Integer total=usage.has("total_tokens")?usage.get("total_tokens").asInt():null; Integer reasoning=usage.has("reasoning_tokens")?usage.get("reasoning_tokens").asInt():null; JsonNode choice=response.path("choices").isEmpty()?null:response.path("choices").get(0); String finish=choice==null?null:choice.path("finish_reason").asText(null); return new AiResult<>(value,input,output,total,response.path("model").asText(fallbackModel),finish,reasoning); }
    private JsonNode post(String url,JsonNode body,String requestModel)throws Exception{
        if(key.isBlank())throw new AiProviderException("NVIDIA",null,false,"NVIDIA_API_KEY is not configured");
        ProviderCallTelemetry.call(url.equals(NVIDIA_EMBEDDINGS_URL)?ProviderCallTelemetry.Kind.EMBEDDING:ProviderCallTelemetry.Kind.CHAT);
        String payload=mapper.writeValueAsString(body);
        for(int attempt=1;attempt<=MAX_PROVIDER_ATTEMPTS;attempt++){
            RequestDeadline.requireTimeRemaining("the NVIDIA "+requestModel+" call");
            long started=System.nanoTime();
            ProviderCallTelemetry.attempt();
            Duration attemptTimeout=RequestDeadline.cap(PER_ATTEMPT_TIMEOUT);
            log.info("NVIDIA request URL: {} model: {} attempt: {} timeoutMs: {}",url,requestModel,attempt,attemptTimeout.toMillis());
            try{
                var request=HttpRequest.newBuilder(URI.create(url)).timeout(attemptTimeout).header("Authorization","Bearer "+key).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(payload)).build();
                var response=client.send(request,HttpResponse.BodyHandlers.ofString());
                String responseBody=response.body()==null?"":response.body();
                log.info("NVIDIA response status: {} durationMs: {} body: {}",response.statusCode(),(System.nanoTime()-started)/1_000_000,logBody(url,responseBody));
                if(response.statusCode()<300)return mapper.readTree(responseBody);
                boolean retryable=transientStatus(response.statusCode(),responseBody);
                if(retryable)ProviderCallTelemetry.transientFailure(response.statusCode(),responseBody==null||responseBody.isBlank()?"blank-body":"http");
                if(retryable&&attempt<MAX_PROVIDER_ATTEMPTS){
                    backOff(retryDelayMillis(attempt,response.headers().firstValue("Retry-After").orElse(null)),"returned transient HTTP "+response.statusCode()+" for model "+requestModel,attempt);
                    continue;
                }
                throw new AiProviderException("NVIDIA",response.statusCode(),retryable,"NVIDIA returned HTTP "+response.statusCode());
            }catch(java.net.http.HttpTimeoutException error){
                ProviderCallTelemetry.transientFailure(null,"timeout");
                if(attempt==MAX_PROVIDER_ATTEMPTS)throw new AiProviderException("NVIDIA",null,true,"NVIDIA request timed out after retries",error);
                backOff(retryDelayMillis(attempt,null),"request timed out",attempt);
            }catch(java.io.IOException error){
                ProviderCallTelemetry.transientFailure(null,"io-"+error.getClass().getSimpleName());
                if(attempt==MAX_PROVIDER_ATTEMPTS)throw new AiProviderException("NVIDIA",null,true,"NVIDIA network request failed after retries",error);
                backOff(retryDelayMillis(attempt,null),"network request failed ("+error.getClass().getSimpleName()+")",attempt);
            }
        }
        throw new AiProviderException("NVIDIA",null,true,"NVIDIA request failed after retries");
    }
    boolean transientStatus(int status,String responseBody){return status==408||status==429||status==500||status==502||status==503||status==504||(status==404&&(responseBody==null||responseBody.isBlank()));}
    /**
     * Waits before the next attempt. The delay is jittered over the lower half of its ceiling so concurrent
     * turns that hit the same rate limit do not come back in lockstep, and it is clamped to the turn's
     * remaining budget so a retry is never scheduled past the point where its answer could still be used.
     */
    private void backOff(long ceilingMillis,String reason,int attempt) throws InterruptedException {
        long delay=jitter(ceilingMillis);
        long sleepable=RequestDeadline.sleepableMillis(delay,ATTEMPT_RESERVE);
        if(sleepable<delay&&RequestDeadline.spent())throw new DeadlineExceededException("a retry of the NVIDIA call");
        log.warn("NVIDIA {}; retrying in {} ms ({}/{})",reason,sleepable,attempt,MAX_PROVIDER_ATTEMPTS);
        if(sleepable>0)Thread.sleep(sleepable);
    }
    static long jitter(long ceilingMillis){return ceilingMillis<2?Math.max(0,ceilingMillis):ceilingMillis/2+java.util.concurrent.ThreadLocalRandom.current().nextLong(ceilingMillis/2+1);}
    long retryDelayMillis(int attempt,String retryAfter){
        if(retryAfter!=null){try{return Math.min(10_000,Math.max(0,Long.parseLong(retryAfter.trim())*1000));}catch(NumberFormatException ignored){}}
        return Math.min(2_000,BASE_RETRY_DELAY_MILLIS*(1L<<Math.max(0,attempt-1)));
    }
    /**
     * Provider responses can carry learner course material, so chat completions are logged as a
     * bounded structural excerpt, never as the full body. Embedding responses carry no course text
     * and stay summarized as before.
     */
    private String logBody(String url,String value){if(value==null)return "";if(url.equals(NVIDIA_EMBEDDINGS_URL)){try{JsonNode parsed=mapper.readTree(value);return "{model="+parsed.path("model").asText(embeddingModel)+", embeddings="+parsed.path("data").size()+", usage="+parsed.path("usage")+"}";}catch(Exception ignored){return "<unparseable embedding response, chars="+value.length()+">";}}String excerpt=value.length()<=400?value:value.substring(0,400)+"… <truncated, chars="+value.length()+">";return excerpt;}
}
