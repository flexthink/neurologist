"""Illustrative architecture for the sample chart; not run by the extension."""
from torch import nn


class TinyEncoder(nn.Module):
    def __init__(self, input_size=128, hidden_size=256):
        super().__init__()
        self.projection = nn.Linear(input_size, hidden_size)

    def forward(self, features):
        projected = self.projection(features)
        return projected.relu() + projected
