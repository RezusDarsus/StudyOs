package com.studyos.ai;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Component
@ConfigurationProperties("studyos.ai")
public class AiUsageProperties {
    private String provider = "stub";
    private String chatModel = "";
    private String embeddingModel = "";
    private String embeddingModelVersion = "1";
    private String primaryModel = "";
    private String internalModel = "";
    private int chatMaxOutputTokens = 3200;
    private int predictionMaxOutputTokens = 8192;
    private boolean thinking;
    private Double inputCostPerMillion;
    private Double outputCostPerMillion;
    public String getProvider() { return provider; }
    public void setProvider(String value) { provider = value; }
    public String getChatModel() { return chatModel; }
    public void setChatModel(String value) { chatModel = value; }
    public String getEmbeddingModel() { return embeddingModel; }
    public void setEmbeddingModel(String value) { embeddingModel = value; }
    public String getEmbeddingModelVersion() { return embeddingModelVersion; }
    public void setEmbeddingModelVersion(String value) { embeddingModelVersion = value; }
    public String getPrimaryModel() { return primaryModel == null || primaryModel.isBlank() ? chatModel : primaryModel; }
    public void setPrimaryModel(String value) { primaryModel = value; }
    public String getInternalModel() { return internalModel; }
    public void setInternalModel(String value) { internalModel = value; }
    public String resolvedInternalModel() { return internalModel == null || internalModel.isBlank() ? getPrimaryModel() : internalModel; }
    public int getChatMaxOutputTokens() { return chatMaxOutputTokens; }
    public void setChatMaxOutputTokens(int value) { chatMaxOutputTokens=value; }
    public int getPredictionMaxOutputTokens() { return predictionMaxOutputTokens; }
    public void setPredictionMaxOutputTokens(int value) { predictionMaxOutputTokens=value; }
    public boolean isThinking() { return thinking; }
    public void setThinking(boolean value) { thinking = value; }
    public Double getInputCostPerMillion() { return inputCostPerMillion; }
    public void setInputCostPerMillion(Double value) { inputCostPerMillion = value; }
    public Double getOutputCostPerMillion() { return outputCostPerMillion; }
    public void setOutputCostPerMillion(Double value) { outputCostPerMillion = value; }
}
